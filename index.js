// dsh-notify — DSH 系统通知插件
//
// 在宿主进程内监听 Cordis 事件，把以下时机以操作系统通知的形式推送出来。
// 通知发送优先走 node-notifier（跨平台封装：Linux→notify-send、
// macOS→terminal-notifier、Windows→snoretoast），库不可用时回退到
// 直接调用系统命令（notify-send / osascript）：
//
//   - 任务完成    agent/status 由 running 回到 idle，且最近一轮 turn/end 的
//                reason 为 completed / max-tokens（只通知根 agent，忽略子 agent）
//   - 任务出错    最近一轮 turn/end 的 reason 为 error
//   - 阻塞提问    tools/execute 派发 ask_user_question（工具阻塞等待用户回答）
//   - 等待审批    approval/request 派发（工具等待用户批准）
//
// 安装、配置与排查见仓库 README.md。

import { execFile } from "node:child_process";
import { createRequire } from "node:module";

/** Cordis 插件名（与组合行的 name 一致）。 */
const name = "dsh-notify";

/** 默认配置；可由组合行的 config 覆盖。 */
const DEFAULTS = {
  enabled: true,
  appName: "DSH",
  notifyOnComplete: true,
  notifyOnError: true,
  notifyOnQuestion: true,
  notifyOnApproval: true,
  // 只通知根 agent（子 agent 完成时静默，避免子代理扇出刷屏）。
  rootsOnly: true,
  completeUrgency: "normal",
  blockingUrgency: "critical",
  errorUrgency: "critical",
  bodyLimit: 100,
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function mergeConfig(config) {
  if (config === null || typeof config !== "object") return { ...DEFAULTS };
  return { ...DEFAULTS, ...config };
}

/** 压缩为单行并截断。 */
function truncate(text, limit) {
  if (typeof text !== "string") return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}

/** 从会话事件日志中自后向前找最后一个指定类型的事件。 */
function lastEvent(agent, type) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event !== null && typeof event === "object" && event.type === type) return event;
  }
  return undefined;
}

/** 最近一轮 turn/end 的 reason（{ kind: "completed" | "max-tokens" | "blocked" | "aborted" | "error", ... }）。 */
function lastTurnReason(agent) {
  return lastEvent(agent, "turn/end")?.data?.reason;
}

/** 会话中最近一条用户消息的纯文本。 */
function lastUserText(agent) {
  const content = lastEvent(agent, "user/message")?.data?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return "";
}

/** 从 ask_user_question 的参数里取出问题文本。 */
function questionText(args) {
  if (args === null || typeof args !== "object") return "";
  const questions = args.questions;
  if (!Array.isArray(questions)) return "";
  const texts = [];
  for (const question of questions) {
    if (question === null || typeof question !== "object") continue;
    const text =
      typeof question.question === "string" && question.question
        ? question.question
        : typeof question.header === "string"
          ? question.header
          : "";
    if (text) texts.push(text);
  }
  return truncate(texts.join(" / "), 120);
}

/** 从 turn/end reason.error 里提取可读信息。 */
function errorText(reason) {
  const error = reason?.error;
  if (error === undefined || error === null) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const message = error.message;
    if (typeof message === "string" && message) return message;
    const code = error.code;
    if (typeof code === "string" && code) return code;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 通知发送
// ---------------------------------------------------------------------------

// 主路径：node-notifier（跨平台封装，处理了各平台的参数映射、转义与
// Windows 支持）。从插件自身位置解析，避免依赖宿主进程的模块图。
// 未安装时置空，走下方回退路径——通知插件不应因缺依赖而拖垮宿主加载。
let notifier = null;
try {
  notifier = createRequire(import.meta.url)("node-notifier");
} catch (error) {
  console.warn(`[dsh-notify] node-notifier 未安装（在仓库目录执行 pnpm install 可装），回退到直接调用系统命令: ${error?.message ?? error}`);
}

/**
 * 发送一条系统通知。
 * @param options 合并后的插件配置（appName 等）
 * @param title 标题
 * @param body 正文
 * @param urgency low | normal | critical（macOS 不支持，会被忽略）
 */
function sendNotification(options, title, body, urgency) {
  console.log(`[dsh-notify] ${title}: ${body}`);

  // 主路径：node-notifier。
  // 平台分派由库内部完成：Linux→notify-send（-a appName、-u urgency），
  // macOS→terminal-notifier，Windows→snoretoast（appName 映射为 appID）。
  if (notifier !== null) {
    try {
      notifier.notify({ title, message: body, urgency, appName: options.appName }, (error) => {
        if (error) console.error(`[dsh-notify] 通知发送失败: ${error.message ?? error}`);
      });
      return;
    } catch (error) {
      console.error(`[dsh-notify] 通知发送失败: ${String(error)}`);
    }
    return;
  }

  // 回退路径：直接调用系统命令（仅当 node-notifier 不可用时）。
  try {
    if (process.platform === "linux") {
      execFile("notify-send", ["-a", options.appName, "-u", urgency, title, body], (error) => {
        if (error) console.error(`[dsh-notify] notify-send 失败: ${error.message}`);
      });
    } else if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      execFile("osascript", ["-e", script], (error) => {
        if (error) console.error(`[dsh-notify] osascript 失败: ${error.message}`);
      });
    } else {
      console.log(`[dsh-notify] 当前平台 ${process.platform} 不支持桌面通知，仅记录日志`);
    }
  } catch (error) {
    console.error(`[dsh-notify] 发送通知失败: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const options = mergeConfig(config);
  if (!options.enabled) {
    console.log("[dsh-notify] disabled by config, not mounting listeners");
    return;
  }

  // 可选依赖：agents（根 agent 过滤）与 commands（测试命令）。
  const agents = ctx.get("agents");
  const commands = ctx.get("commands");

  function isRoot(agent) {
    if (agent === undefined) return !options.rootsOnly;
    if (!options.rootsOnly) return true;
    if (agents === undefined) return true;
    return agents.roots().some((root) => root.id === agent.id);
  }

  // 1) 任务完成 / 任务出错：agent 由 running 回到 idle（此刻 turn/end 已落盘）。
  ctx.on("agent/status", (payload) => {
    try {
      if (payload?.status !== "idle") return;
      const agent = payload.agent;
      if (!isRoot(agent)) return;
      const reason = lastTurnReason(agent);
      if (reason === undefined) return;
      if (reason.kind === "completed" || reason.kind === "max-tokens") {
        if (!options.notifyOnComplete) return;
        const summary = truncate(lastUserText(agent), options.bodyLimit) || `会话 ${agent.id}`;
        const suffix = reason.kind === "max-tokens" ? "（达到输出上限）" : "";
        sendNotification(options, `${options.appName} · 任务完成${suffix}`, summary, options.completeUrgency);
      } else if (reason.kind === "error") {
        if (!options.notifyOnError) return;
        const detail = truncate(errorText(reason), options.bodyLimit) || "agent 运行出错";
        sendNotification(options, `${options.appName} · 任务出错`, detail, options.errorUrgency);
      }
      // kind === "aborted"（用户取消）与 "blocked"（内部拒绝）不通知。
    } catch (error) {
      console.error(`[dsh-notify] agent/status 处理失败: ${String(error)}`);
    }
  });

  // 2) 阻塞提问：ask_user_question 派发后工具会一直阻塞到用户回答。
  ctx.on("tools/execute", (exec, next) => {
    try {
      if (exec?.name === "ask_user_question" && options.notifyOnQuestion && isRoot(exec.agent)) {
        const text = questionText(exec.arguments);
        sendNotification(
          options,
          `${options.appName} · 需要你回答`,
          text || "agent 正在等待你的回答",
          options.blockingUrgency,
        );
      }
    } catch (error) {
      console.error(`[dsh-notify] tools/execute 处理失败: ${String(error)}`);
    }
    return next();
  });

  // 3) 等待审批：工具派发被审批环节挂起。
  ctx.on("approval/request", (req, next) => {
    try {
      if (options.notifyOnApproval && isRoot(req?.agent)) {
        const detail = truncate(req.reason ?? "", options.bodyLimit) || `工具 ${req.toolName ?? "?"} 需要审批`;
        sendNotification(options, `${options.appName} · 等待审批`, detail, options.blockingUrgency);
      }
    } catch (error) {
      console.error(`[dsh-notify] approval/request 处理失败: ${String(error)}`);
    }
    return next();
  });

  // 测试命令：/dsh-notify-test —— 手动验证通知链路。
  if (commands !== undefined) {
    ctx.effect(function* () {
      yield commands.register({
        name: "dsh-notify-test",
        description: "发送一条 dsh-notify 测试系统通知",
        handler: (invocation) => {
          sendNotification(options, `${options.appName} · 测试通知`, "dsh-notify 插件工作正常", "normal");
          return { kind: "success", text: "已发送测试通知，请查看系统通知栏。" };
        },
      });
    }, "dsh-notify test command");
  }

  console.log(
    `[dsh-notify] 插件已挂载 (rootsOnly=${options.rootsOnly}, notifyOnComplete=${options.notifyOnComplete}, ` +
      `notifyOnQuestion=${options.notifyOnQuestion}, notifyOnApproval=${options.notifyOnApproval}, ` +
      `notifyOnError=${options.notifyOnError})`,
  );
}

export { apply, name };
