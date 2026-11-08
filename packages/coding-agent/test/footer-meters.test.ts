import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { countOutputTokens, FooterMeters } from "../src/modes/interactive/components/footer-meters.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function assistant(text: string, outputTokens: number, thinking = ""): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (thinking) content.push({ type: "thinking", thinking });
	if (text) content.push({ type: "text", text });
	return {
		role: "assistant",
		content,
		usage: {
			input: 0,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: outputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as AssistantMessage;
}

function createSession(): AgentSession {
	const session = {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [],
			getEntryCount: () => 0,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: () => false },
	};
	return session as unknown as AgentSession;
}

const footerData: ReadonlyFooterDataProvider = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

describe("countOutputTokens", () => {
	it("takes the provider's count once it streams one", () => {
		expect(countOutputTokens(assistant("abcd", 150))).toEqual({ tokens: 150, estimated: false });
	});

	it("estimates from the streamed text while the provider reports no usage", () => {
		expect(countOutputTokens(assistant("a".repeat(400), 0))).toEqual({ tokens: 100, estimated: true });
	});

	it("counts thinking in the estimate", () => {
		expect(countOutputTokens(assistant("", 0, "t".repeat(40)))).toEqual({ tokens: 10, estimated: true });
	});
});

describe("FooterMeters", () => {
	it("computes a one-second frame rate and marks a window with no frame", () => {
		let now = 0;
		let frames = 0;
		const meters = new FooterMeters({ getFrameCount: () => frames, requestRender: () => {}, now: () => now });
		meters.setDisplay({ showFps: true, showTokenRate: false, showTurnTime: false });
		expect(meters.values()).toMatchObject({ fps: 0, fpsStale: true });

		now = 400;
		frames = 10;
		// A rate needs a whole second: the window is not up yet.
		expect(meters.values().fps).toBe(0);

		now = 1000;
		frames = 30;
		const live = meters.values();
		expect(live.fps).toBeCloseTo(30);
		expect(live.fpsStale).toBe(false);

		now = 2000;
		frames = 60;
		expect(meters.values().fps).toBeCloseTo(30);

		now = 5000;
		const idle = meters.values();
		expect(idle.fps).toBe(0);
		expect(idle.fpsStale).toBe(true);
	});

	it("hides the fps meter when its setting is off", () => {
		const meters = new FooterMeters({ getFrameCount: () => 0, requestRender: () => {}, now: () => 0 });
		meters.setDisplay({ showFps: false, showTokenRate: true, showTurnTime: true });
		expect(meters.values().fps).toBeUndefined();
	});

	it("times the running turn and keeps its time after it ends", () => {
		let now = 1000;
		const meters = new FooterMeters({ getFrameCount: () => 0, requestRender: () => {}, now: () => now });
		meters.setDisplay({ showFps: false, showTokenRate: false, showTurnTime: true });
		meters.turnStarted();
		now = 3500;
		expect(meters.values().turnSeconds).toBeCloseTo(2.5);
		expect(meters.values().turnRunning).toBe(true);

		meters.turnEnded();
		now = 9000;
		const values = meters.values();
		expect(values.turnSeconds).toBeCloseTo(2.5);
		expect(values.turnRunning).toBe(false);
		meters.dispose();
	});

	it("measures the live rate from the first streamed token, then the turn's average", () => {
		let now = 0;
		const meters = new FooterMeters({ getFrameCount: () => 0, requestRender: () => {}, now: () => now });
		meters.setDisplay({ showFps: false, showTokenRate: true, showTurnTime: false });
		meters.turnStarted();
		now = 1000;
		// The provider reports no usage yet: the first token starts the clock.
		meters.assistantStreaming(assistant("abcd", 0));
		now = 2000;
		meters.assistantStreaming(assistant("a".repeat(400), 0));
		const live = meters.values();
		expect(live.tokenRate).toBeCloseTo(100);
		expect(live.tokenRateLive).toBe(true);

		now = 3000;
		// The final message carries the provider's own count: 150 tokens over 2 s.
		meters.assistantMessageEnded(assistant("a".repeat(400), 150));
		const settled = meters.values();
		expect(settled.tokenRateLive).toBe(false);
		expect(settled.tokenRate).toBeCloseTo(75);

		now = 5000;
		meters.turnEnded();
		expect(meters.values().tokenRate).toBeCloseTo(75);
		expect(meters.values().turnSeconds).toBeUndefined();
		meters.dispose();
	});

	it("refreshes a running turn once a second and schedules nothing while idle", () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			let renders = 0;
			const meters = new FooterMeters({
				getFrameCount: () => 0,
				requestRender: () => {
					renders++;
				},
				now: () => now,
			});
			meters.setDisplay({ showFps: true, showTokenRate: true, showTurnTime: true });
			// Idle: no timer at all.
			expect(vi.getTimerCount()).toBe(0);

			meters.turnStarted();
			expect(vi.getTimerCount()).toBe(1);
			now = 3000;
			vi.advanceTimersByTime(3000);
			// One frame a second, no more.
			expect(renders).toBe(3);

			meters.turnEnded();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(5000);
			expect(renders).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("schedules no timer when the live meters are off", () => {
		vi.useFakeTimers();
		try {
			const meters = new FooterMeters({ getFrameCount: () => 0, requestRender: () => {}, now: () => 0 });
			meters.setDisplay({ showFps: true, showTokenRate: false, showTurnTime: false });
			meters.turnStarted();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("footer meter rendering", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("draws the meters the settings enable", () => {
		let now = 0;
		let frames = 0;
		const meters = new FooterMeters({ getFrameCount: () => frames, requestRender: () => {}, now: () => now });
		meters.setDisplay({ showFps: true, showTokenRate: true, showTurnTime: true });
		const footer = new FooterComponent(createSession(), footerData);
		footer.setMeters(meters);

		// A frame at t=0 samples the counter; the turn and a streamed message follow.
		expect(stripAnsi(footer.render(160)[1])).toContain("0fps");
		meters.turnStarted();
		now = 1000;
		frames = 20;
		meters.assistantStreaming(assistant("abcd", 0));
		now = 2000;
		frames = 40;
		meters.assistantStreaming(assistant("a".repeat(400), 0));

		const statsLine = stripAnsi(footer.render(160)[1]);
		expect(statsLine).toContain("2.0s");
		expect(statsLine).toContain("100tok/s");
		expect(statsLine).toContain("20fps");
		meters.dispose();
	});

	it("draws no meters when the settings disable them", () => {
		const meters = new FooterMeters({ getFrameCount: () => 0, requestRender: () => {}, now: () => 0 });
		meters.setDisplay({ showFps: false, showTokenRate: false, showTurnTime: false });
		const footer = new FooterComponent(createSession(), footerData);
		footer.setMeters(meters);
		meters.turnStarted();
		meters.dispose();

		const statsLine = stripAnsi(footer.render(160)[1]);
		expect(statsLine).not.toContain("tok/s");
		expect(statsLine).not.toContain("fps");
		expect(statsLine).not.toMatch(/\d\.\ds/);
	});

	it("draws no meters without a meters object", () => {
		const footer = new FooterComponent(createSession(), footerData);
		const statsLine = stripAnsi(footer.render(160)[1]);
		expect(statsLine).not.toContain("tok/s");
		expect(statsLine).not.toContain("fps");
	});

	it("keeps the stats line within the width with every meter on", () => {
		let now = 0;
		const meters = new FooterMeters({ getFrameCount: () => 500, requestRender: () => {}, now: () => now });
		meters.setDisplay({ showFps: true, showTokenRate: true, showTurnTime: true });
		meters.turnStarted();
		now = 60_000;
		meters.assistantStreaming(assistant("a".repeat(4000), 0));
		const footer = new FooterComponent(createSession(), footerData);
		footer.setMeters(meters);

		for (const width of [20, 40, 60]) {
			for (const line of footer.render(width)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
		meters.dispose();
	});
});
