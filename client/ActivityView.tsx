import { useState } from 'react';
import { ArrowRight, Clock3, Search } from 'lucide-react';
import type { Activity, Session } from '../shared/types';

const activityLabels: Record<string, string> = {
  create: '新建联系人', import: '导入会话', fork: 'Fork 会话', start: '进入原生会话',
  status: '状态变化', group: '群组', delivery: '任务投递',
};
const localDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const dateLabel = (value: string) => {
  const day = localDate(value);
  if (day === localDate(new Date().toISOString())) return `今天 · ${day}`;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  return day === localDate(yesterday.toISOString()) ? `昨天 · ${day}` : day;
};

export default function ActivityView({ activities, sessions, open }: {
  activities: Activity[]; sessions: Session[]; open: (session: Session) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const ordered = [...activities].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const visible = ordered.filter((activity) => (kind === 'all' || activity.type === kind)
    && `${activity.text} ${sessions.find((session) => session.id === activity.sessionId)?.title ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const days = new Map<string, Activity[]>();
  for (const activity of visible) {
    const key = dateLabel(activity.createdAt);
    days.set(key, [...(days.get(key) ?? []), activity]);
  }
  return <section className="activity-view" aria-label="工作空间活动">
    <div className="activity-filters"><label className="search-field"><Search size={16} /><input id="activity-search" aria-label="搜索活动" placeholder="搜索活动或联系人…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="按活动类型筛选" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">全部活动</option>{[...new Set(ordered.map((activity) => activity.type))].map((type) => <option key={type} value={type}>{activityLabels[type] ?? '其他记录'}</option>)}</select><span>{visible.length} 条记录</span></div>
    {!visible.length ? <div className="activity-empty"><Clock3 size={32} /><h2>{activities.length ? '没有匹配的活动' : '还没有工作空间活动'}</h2><p>{activities.length ? '调整关键词或活动类型，查看其他记录。' : '创建联系人、Fork 或投递任务后，会在这里留下记录。'}</p>{(query || kind !== 'all') && <button className="button secondary" onClick={() => { setQuery(''); setKind('all'); }}>清除筛选</button>}</div> : [...days].map(([date, items]) => <section className="activity-day" key={date}><h2>{date}</h2><ol>{items.map((activity) => {
      const session = sessions.find((item) => item.id === activity.sessionId);
      return <li key={activity.id}><span className={`activity-point type-${activity.type}`} /><time dateTime={activity.createdAt} title={new Date(activity.createdAt).toLocaleString('zh-CN')}>{new Date(activity.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><span className="activity-kind">{activityLabels[activity.type] ?? '记录'}</span><p>{activity.text}</p>{session && <button className="text-button activity-session" onClick={() => open(session)}>{session.title}{session.archived ? ' · 已归档' : ''}<ArrowRight size={13} /></button>}</div></li>;
    })}</ol></section>)}
    {!!activities.length && <p className="activity-footnote">显示本机保留的最近活动；会话的实时状态请以联系人卡片为准。</p>}
  </section>;
}
