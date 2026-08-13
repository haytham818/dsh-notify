# dsh-notify

DSH（DeepSeek Harness）系统通知插件：当 agent **完成任务**、**出错**、**阻塞等待你的回答**或**等待审批**时，向操作系统发送桌面通知（通过 node-notifier 跨平台封装，Linux 走 `notify-send`，macOS 走 terminal-notifier，Windows 走 snoretoast），这样你切走窗口也能第一时间知道。

## 触发场景

| 场景 | 通知标题 | 说明 |
| --- | --- | --- |
| 任务完成 | `DSH · 任务完成` | agent 结束一轮运行回到 idle（turn/end reason 为 completed / max-tokens），正文为最近一条用户消息摘要 |
| 任务出错 | `DSH · 任务出错` | 一轮运行以 error 结束，正文为错误信息 |
| 阻塞提问 | `DSH · 需要你回答` | agent 调用 `ask_user_question`，工具阻塞等待你的回答，正文为问题文本 |
| 等待审批 | `DSH · 等待审批` | agent 的工具派发被审批环节挂起，正文为审批原因 |

默认只通知**根 agent**（子 agent 完成任务不通知，避免子代理扇出刷屏），用户主动取消（aborted）不通知。

## 安装

```bash
# 1. 安装插件依赖（node-notifier）。dsh plugin add 只链接仓库、不会装它的依赖，
#    必须先在仓库目录执行一次安装：
cd /home/haytham/Repos/dsh-notify && pnpm install   # 或 npm install

# 2. 把本仓库加入 dsh web profile（会在 profile 的 node_modules 里建链接）
dsh plugin --profile web add "link:/home/haytham/Repos/dsh-notify"

# 3. 在 ~/.dsh/profiles/web/cordis.patch.yml 中追加插入行（profile 的 HMR 会自动热加载）：
```

```yaml
- insert:
    - id: dsh-notify
      name: dsh-notify
```

## 配置

插入行可带 `config` 覆盖默认配置（`apply(ctx, config)` 与默认值合并）：

```yaml
- insert:
    - id: dsh-notify
      name: dsh-notify
      config:
        appName: DSH
        notifyOnComplete: true
        notifyOnError: true
        notifyOnQuestion: true
        notifyOnApproval: true
        rootsOnly: true
        completeUrgency: normal   # low | normal | critical
        blockingUrgency: critical # 提问/审批（等待你操作）默认 critical（常驻）
        errorUrgency: critical
        bodyLimit: 100
        enabled: true
```

## 测试

- 在会话里输入 `/dsh-notify-test`，会立即发送一条「测试通知」。
- 或者随便给 agent 一个任务，运行结束后应出现「任务完成」通知。

## 原理

- **任务完成/出错**：监听 `agent/status`（`running` → `idle`）。agent 阻塞等待提问/审批时 phase 保持 `running`（工具调用挂起），只有真正结束运行才回到 `idle`，此时最近一轮 `turn/end` 的 reason 已落盘，据此区分 completed / max-tokens / error / aborted / blocked。
- **阻塞提问**：监听 `tools/execute` 瀑布，识别 `ask_user_question` 派发（该工具会一直阻塞到用户回答）。
- **等待审批**：监听 `approval/request` 瀑布（必须调用并返回 `next()` 以保持审批链）。
- 根 agent 过滤：`agents.roots()`。
- 通知发送：通过 **node-notifier** 跨平台封装——Linux 走 `notify-send`（`-a` 应用名、`-u` 优先级）、macOS 走内置的 terminal-notifier、Windows 走 snoretoast（应用名映射为 toast appID）。库未安装时回退为直接调用 `notify-send` / `osascript`。失败只记日志不影响 agent。

## 排查

- 通知没出现：确认 `notify-send` 在 PATH（`command -v notify-send`，node-notifier 的 Linux 后端同样依赖它），且 dsh 宿主进程继承了桌面会话环境（`DBUS_SESSION_BUS_ADDRESS`、`DISPLAY`/`WAYLAND_DISPLAY`）。从终端启动 dsh 一般没问题；若以 systemd user service 启动，检查服务的环境。
- 宿主日志中 `[dsh-notify]` 前缀会打印每次通知内容与失败原因（`dsh` 启动时的终端输出）。若日志出现「node-notifier 未安装」警告，说明仓库依赖没装好（见安装步骤 1）。
- Windows：原生支持（snoretoast），无需额外配置。
- 挂载是否成功：输入 `/dsh-notify-test`，能执行即已挂载。
