# dsh-serverChan（消息推送）

DSH 插件：**每轮任务完成后**把结果推到手机/群里。

- 对话工具行里「权限」控件旁多一个**推送开关**，按会话控制（`/service_push on|off|status` 同效）。
- 会话开关写进会话日志，**fork 出来的会话自动继承**。
- **多端实时同步**：从远程访问 / 另一个窗口切换开关后，本地页面图标立刻更新（SSE）。
- 设置里有独立「消息推送」页：新会话默认、触发时机、节流、通道管理、测试与最近推送记录。
- 通道：**Server酱（Turbo / Server酱³）、飞书群机器人、企业微信群机器人、钉钉群机器人、Telegram、Bark、自定义 Webhook**。

## 安装

```bash
# 从 GitHub 安装到当前 profile
dsh plugin add github:sugar-zero/dsh-serverChan --profile desktop

# 或从本地目录安装
dsh plugin add /path/to/dsh-serverChan --profile desktop
```

安装后 Host 半热生效；Web 半若没自动出现，刷新一次页面 / 重启 DSH。

## 使用

1. 打开 **设置 → 消息推送**，点「添加通道」，填好并「测试」。
2. 需要哪一轮推哪一轮：在对话输入框工具行点「推送」开关（或输入 `/service_push on`）。
3. 新会话默认是否开启，在设置页第一项；默认**关**。
4. 推送正文：状态 + 会话标题 + 用时 + 工作区 + 模型 + 最后回复摘要。摘要可在设置页关掉；摘要长度有两种模式：**「通道上限」**（不自行截断，由每个通道按自己的能力截）。**「自定义」**（按字数截，填 **0** = 不附带摘要，不会只留一个省略号）。

## 存储

配置与密钥都在 `$DSH_HOME/push-notify/`：

- `config.json` — 设置与通道（含密钥，文件权限 0600，GET 接口只回掩码）
- `last.json` — 最近 20 条推送结果
- `plugin.log` — 运行日志

## 已知限制

- Server酱 Turbo 免费版每天约 5 条推送；「每轮都推」很快会用完，建议只在长任务时开会话开关，或配「最短耗时」节流。
- 推送里的 DSH 会话链接是回环地址（`127.0.0.1`），手机点不开；需要远程访问请另配。
- 通道返回成功只代表服务商已接收，不代表手机一定弹出。
- 会话开关状态来自会话日志里的 `/service_push` 命令事件：每点一次开关（或输入 `/service_push on|off`）会在对话里留下一条命令记录（与切换权限同类），fork 继承也依赖它；手动删日志里的命令记录会改变状态。

## 开发

```bash
node test/smoke.mjs            # 通道 payload / 消息拼装 / 状态折叠 / 摘要截断
node test/host-integration.mjs # 用假 ctx 跑完整 Host：路由、/service_push、turn/end → 真实 HTTP 推送
node test/client-load.mjs      # 客户端模块格式与两个 slot 注册
```
