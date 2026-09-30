# 本地开发约定

## 保护正在使用的实例

- Codex / Claude 会话可能由本项目自身托管。开始工作先辨认现有服务；不要在被托管的会话中停止或重启承载自己的服务，否则会同时终止用户会话。
- 开发和验收使用独立端口、`SESSIONDECK_DATA_DIR` 和 `SESSIONDECK_CLIENT_DIR`。`npm run test:web` 已自动隔离这三项，拒绝复用已有服务。
- 仅清理本轮测试启动且仍可确认身份的进程。不要按端口杀进程、使用宽泛 `pkill`，或删除正在使用的数据锁。
- 前端构建使用 `npm run build`：它在暂存目录构建，保留旧哈希资源，最后原子替换入口。不要直接运行会清空在线目录的 `vite build`，也不要删除正在服务的 `dist/client`。
- 活动服务使用稳定启动方式；`--dev` / `tsx watch` 修改后端会重启服务并中断其会话和终端。更新依赖时使用独立 checkout/worktree 和独立 `node_modules`，避免替换活动服务的依赖。

## 验证与版本管理

- `npm run check` 做类型检查，`npm test` 验证服务端，`npm run test:web` 构建并测试隔离的演示实例；`npm run verify` 串行执行三者。
- 可以使用 `SESSIONDECK_TEST_PORT` 避开占用的测试端口；默认 Web 端口 `4317` 不能用作浏览器测试端口。
- 本地开发、测试和提交不构成云端操作授权。未获得针对具体操作的明确授权，不创建、删除、推送或修改云端仓库；也不创建 Git tag。
