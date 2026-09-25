import type { Activity, AppState, BackendInfo, Group, Session, StatePatch } from '../shared/types.ts';
import type { Store, StoreChange } from './store.ts';

/** Cache committed metadata once; broadcasts serialize only changed entities.
 * Snapshot reads do not consume patches or advance the version. */
export class StatePublisher {
  private sessionMap: Map<string, Session>;
  private groupMap: Map<string, Group>;
  private activityMap: Map<string, Activity>;
  private revision = 0;
  private publishedRevision = 0;
  private changedSessions = new Map<string, Session>();
  private changedGroups = new Map<string, Group>();
  private changedActivities = new Map<string, Activity>();
  private removedActivities = new Set<string>();
  private backendsChanged = false;
  private unsubscribe: () => void;
  constructor(store: Store, private options: { instanceId: string; backends: BackendInfo[]; defaultCwd: string; demo: boolean }) {
    this.sessionMap = new Map(store.sessions().map(item => [item.id, item]));
    this.groupMap = new Map(store.groups().map(item => [item.id, item]));
    this.activityMap = new Map(store.activities().reverse().map(item => [item.id, item]));
    this.unsubscribe = store.onChange(change => this.change(change));
  }
  private change(change: StoreChange) {
    this.revision++;
    if (change.table === 'sessions') { this.sessionMap.set(change.data.id, change.data); this.changedSessions.set(change.data.id, change.data); }
    else if (change.table === 'groups') { this.groupMap.set(change.data.id, change.data); this.changedGroups.set(change.data.id, change.data); }
    else {
      this.activityMap.set(change.data.id, change.data); this.changedActivities.set(change.data.id, change.data);
      while (this.activityMap.size > 100) {
        const oldest = this.activityMap.keys().next().value!;
        this.activityMap.delete(oldest); this.changedActivities.delete(oldest); this.removedActivities.add(oldest);
      }
    }
  }
  sessions() { return [...this.sessionMap.values()]; }
  setBackends(backends: BackendInfo[]) { this.options = { ...this.options, backends }; this.backendsChanged = true; this.revision++; }
  snapshot(): AppState {
    return { ...this.options, revision: this.revision, sessions: this.sessions(), groups: [...this.groupMap.values()], activities: [...this.activityMap.values()].reverse() };
  }
  takePatch(): StatePatch | null {
    if (this.revision === this.publishedRevision) return null;
    const patch: StatePatch = { instanceId: this.options.instanceId, baseRevision: this.publishedRevision, revision: this.revision };
    if (this.changedSessions.size) patch.sessions = [...this.changedSessions.values()];
    if (this.changedGroups.size) patch.groups = [...this.changedGroups.values()];
    if (this.changedActivities.size || this.removedActivities.size) patch.activities = { upsert: [...this.changedActivities.values()], remove: [...this.removedActivities] };
    if (this.backendsChanged) patch.backends = this.options.backends;
    this.changedSessions.clear(); this.changedGroups.clear(); this.changedActivities.clear(); this.removedActivities.clear(); this.backendsChanged = false;
    this.publishedRevision = this.revision;
    return patch;
  }
  close() { this.unsubscribe(); }
}
