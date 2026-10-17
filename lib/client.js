/**
 * dsh-plugin-cost-meter — browser half.
 *
 * Renders a small, passive cost pill into the conversation header's
 * right-aligned utilities slot (`conversation.session.header.utilities` — the
 * top-right corner of the session header). The value is the `costUsage`
 * session projection registered by the host half, read through the framework
 * `useProjection` hook; it updates live as the host reports provider usage.
 *
 * An unpriced route renders "未配置" instead of a fabricated amount, matching
 * the host's `priced: false` contract.
 *
 * Loaded by the client module loader (`window.__ModuleLoader__`).
 */
const TAG_ID = "dsh-plugin-cost-meter/client.css";

const css = [
  ".dsh-cost-meter-badge{",
  "box-sizing:border-box;",
  "border:0.5px solid var(--dsw-alias-border-l2);",
  "color:var(--dsw-alias-label-primary);",
  "font-family:var(--dsw-font-family);",
  "background:transparent;",
  "border-radius:var(--dsw-radius-sm);",
  "height:24px;",
  "padding:0 8px;",
  "font-size:12px;",
  "font-weight:400;",
  "line-height:16px;",
  "display:inline-flex;",
  "align-items:center;",
  "justify-content:center;",
  "white-space:nowrap;",
  "font-variant-numeric:tabular-nums;",
  "cursor:default;",
  "}",
  ".dsh-cost-meter-badge[data-priced='0']{",
  "color:var(--dsw-alias-label-dimmed);",
  "border-style:dashed;",
  "}"
].join("");

window.__ModuleLoader__.load({
  id: "dsh-plugin-cost-meter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");

    // Inject the badge stylesheet once.
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-cost-meter";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    var cssClass = { badge: "dsh-cost-meter-badge" };

    /** Format a cost with adaptive precision for tiny per-conversation sums. */
    function formatCost(cost, currency) {
      var abs = Math.abs(cost);
      var fractionDigits;
      if (abs === 0) fractionDigits = 2;
      else if (abs >= 1) fractionDigits = 2;
      else if (abs >= 0.01) fractionDigits = 4;
      else if (abs >= 0.0001) fractionDigits = 6;
      else fractionDigits = 8;
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: currency,
          currencyDisplay: "narrowSymbol",
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits
        }).format(cost);
      } catch (_err) {
        return cost.toFixed(fractionDigits) + " " + currency;
      }
    }

    /** Hover breakdown for the badge. */
    function tooltip(value) {
      var tier = value.currentTier === "peak" ? "高峰时段 (x" + value.peakMultiplier + ")" : "空闲时段";
      var route = (value.provider != null ? value.provider + "/" : "") + (value.model != null ? value.model : "未知");
      var lines = [
        "当前对话估算费用",
        "当前时段: " + tier,
        "模型: " + route,
        "输入: " + value.uncachedInputTokens.toLocaleString() + " tokens",
        "输出: " + value.outputTokens.toLocaleString() + " tokens",
        "缓存命中读取: " + value.cacheReadTokens.toLocaleString() + " tokens",
        "缓存写入: " + value.cacheWriteTokens.toLocaleString() + " tokens"
      ];
      if (!value.priced) {
        lines.push("");
        lines.push("未配置价格: " + (value.unpricedRoutes || []).join(", "));
        lines.push("请在插件 config.models 或价格目录中补充该模型");
      } else {
        lines.push("");
        lines.push("价格随目录自动同步; 可在插件 config 中覆盖");
      }
      return lines.join("\n");
    }

    /**
     * The badge. Session-scope standard kit supplies `useProjection`; the
     * value reads `undefined` until the first projection baseline lands.
     */
    function CostBadge(props) {
      var useProjection = props.useProjection;
      var value = useProjection("costUsage");
      if (!value) return null;
      var priced = value.priced !== false;
      var label = priced ? formatCost(value.cost, value.currency) : "未配置";
      var description = tooltip(value);
      return react_jsx_runtime.jsx("span", {
        className: cssClass.badge,
        title: description,
        role: "status",
        "aria-label": description,
        "data-priced": priced ? "1" : "0",
        children: label
      });
    }

    var inject = ["slots"];

    /**
     * Mount the badge into the header utilities slot once ui-conversation
     * declares it.
     * @param ctx - browser root context carrying the slots service.
     */
    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "cost-meter",
          order: 0
        }, CostBadge);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
