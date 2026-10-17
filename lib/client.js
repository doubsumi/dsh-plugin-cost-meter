/**
 * dsh-cost-meter — browser half.
 *
 * Renders a small, passive cost pill into the conversation header's
 * right-aligned utilities slot (`conversation.session.header.utilities` — the
 * top-right corner of the session header). The value is the `costUsage`
 * session projection registered by the host half, read through the framework
 * `useProjection` hook; it updates live as the host reports provider usage.
 *
 * Loaded by the client module loader (`window.__ModuleLoader__`), exactly like
 * the shipped `@deepseek-ai/dsh-session-log-export` client half.
 */
const TAG_ID = "dsh-cost-meter/client.css";

const css = [
	".dsh-cost-meter-badge{",
	"border:1px solid var(--dsw-alias-border-l2);",
	"color:var(--dsw-alias-label-primary);",
	"font-family:var(--dsw-font-family);",
	"background:transparent;",
	"border-radius:18px;",
	"height:32px;",
	"padding:6px 12px;",
	"font-size:13px;",
	"font-weight:400;",
	"line-height:20px;",
	"display:inline-flex;",
	"align-items:center;",
	"white-space:nowrap;",
	"font-variant-numeric:tabular-nums;",
	"cursor:default;",
	"margin-right:8px;",
	"box-sizing:border-box;", // 新增
	"}"
].join("");

window.__ModuleLoader__.load({
	id: "dsh-cost-meter",
	factory: (require) => {
		var module = {
			exports: {}
		};
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, {
			value: "Module"
		});
		var react_jsx_runtime = require("react/jsx-runtime");

		// Inject the badge stylesheet once.
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON
				.stringify(TAG_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cost-meter";
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		var cssClass = {
			badge: "dsh-cost-meter-badge"
		};

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
			var nowTier = typeof value.currentTier === "string" ? value.currentTier : "off";
			var mult = typeof value.peakMultiplier === "number" ? value.peakMultiplier : 2;
			var tierLabel = nowTier === "peak" ? "高峰时段 (x" + mult + ")" : "空闲时段";
			return [
				"当前对话估算费用",
				"当前时段: " + tierLabel,
				"模型: " + (value.model != null ? value.model : "未知"),
				"输入: " + value.uncachedInputTokens.toLocaleString() + " tokens",
				"输出: " + value.outputTokens.toLocaleString() + " tokens",
				"缓存命中读取: " + value.cacheReadTokens.toLocaleString() + " tokens",
				"缓存写入: " + value.cacheWriteTokens.toLocaleString() + " tokens",
				"按请求时间逐条峰谷计价; 价格可在插件 config 中设置"
			].join("\n");
		}

		/**
		 * The badge. Session-scope standard kit supplies `useProjection`; the
		 * value reads `undefined` until the first projection baseline lands.
		 */
		function CostBadge(props) {
			var useProjection = props.useProjection;
			var value = useProjection("costUsage");
			if (!value) return null;
			var label = formatCost(value.cost, value.currency);
			var description = tooltip(value);
			return react_jsx_runtime.jsx("span", {
				className: cssClass.badge,
				title: description,
				role: "status",
				"aria-label": description,
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
			ctx.slots.inject("conversation.session.header.utilities", function() {
				return ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "cost-meter",
					order: -1
				}, CostBadge);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});