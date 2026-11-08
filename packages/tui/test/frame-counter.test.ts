import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Line implements Component {
	render(_width: number): string[] {
		return ["frame"];
	}
	invalidate(): void {}
}

describe("frame counter", () => {
	it("counts one frame per written frame", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Line());
		assert.equal(tui.frameCount, 0);

		tui.renderNow();
		assert.equal(tui.frameCount, 1);

		tui.renderNow();
		tui.renderNow();
		assert.equal(tui.frameCount, 3);
	});
});
