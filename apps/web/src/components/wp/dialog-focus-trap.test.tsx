// @vitest-environment jsdom

import { Button } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@bfa-platform/ui/components/dialog";
import { Input } from "@bfa-platform/ui/components/input";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Tab and Shift+Tab must not reach the page behind an open modal.
 *
 * Base UI traps focus already, with a visually hidden guard either side of the
 * popup, but its redirect off a guard is deferred to `requestAnimationFrame`.
 * For that one frame the focus is on a guard outside the popup, and a second
 * Tab arriving first walks out to the page — deterministic if the frame never
 * lands, which is what a blocked main thread amounts to. `DialogContent` closes
 * that window by wrapping the ends synchronously in the keydown, and these are
 * the tests for that wrap.
 *
 * They assert the synchronous behaviour on purpose: a test that waited for a
 * frame would pass on Base UI's deferred redirect alone and so would not notice
 * the wrap being removed.
 */

function Fixture() {
	return (
		<>
			<button type="button" data-testid="behind-before">
				behind before
			</button>

			<Dialog open>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Trap</DialogTitle>
						<DialogDescription>Two fields and two buttons.</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Input name="one" />
						<Input name="two" />
					</DialogBody>
					<DialogFooter>
						<Button variant="secondary">Cancel</Button>
						<Button>Confirm</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<button type="button" data-testid="behind-after">
				behind after
			</button>
		</>
	);
}

function ControlledFixture() {
	const [open, setOpen] = useState(true);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Trap</DialogTitle>
					<DialogDescription>Closable with Escape.</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Input name="one" />
				</DialogBody>
				<DialogFooter>
					<Button>Confirm</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Everything Tab can land on inside the popup, in tab order. */
function controlsIn(dialog: HTMLElement) {
	return Array.from(
		dialog.querySelectorAll<HTMLElement>("input, button"),
	).filter((element) => !element.hasAttribute("data-base-ui-focus-guard"));
}

afterEach(() => {
	cleanup();
});

describe("dialog focus trap", () => {
	it("wraps Tab from the last control back to the first, in the keydown", () => {
		render(<Fixture />);

		const dialog = screen.getByRole("dialog");
		const controls = controlsIn(dialog);
		const first = controls[0];
		const last = controls[controls.length - 1];

		// The close button is last, so this is the edge a keyboard user reaches
		// on the way out of the dialog.
		expect(last?.getAttribute("aria-label")).toBe("Close");

		last?.focus();
		expect(document.activeElement).toBe(last);

		const wrapped = fireEvent.keyDown(last as HTMLElement, {
			key: "Tab",
			code: "Tab",
		});

		// Handled here rather than left to the browser's own tab order, which is
		// what would carry focus onto the guard and out of the dialog.
		expect(wrapped).toBe(false);
		expect(document.activeElement).toBe(first);
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("wraps Shift+Tab from the first control back to the last", () => {
		render(<Fixture />);

		const dialog = screen.getByRole("dialog");
		const controls = controlsIn(dialog);
		const first = controls[0];
		const last = controls[controls.length - 1];

		first?.focus();

		const wrapped = fireEvent.keyDown(first as HTMLElement, {
			key: "Tab",
			code: "Tab",
			shiftKey: true,
		});

		expect(wrapped).toBe(false);
		expect(document.activeElement).toBe(last);
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("leaves Tab alone in the middle of the dialog", () => {
		// The wrap is only for the two ends. Taking the keydown anywhere else
		// would put this component in charge of the whole tab order, which is
		// Base UI's job and the browser's.
		render(<Fixture />);

		const dialog = screen.getByRole("dialog");
		const controls = controlsIn(dialog);
		const middle = controls[1];

		middle?.focus();

		const notHandled = fireEvent.keyDown(middle as HTMLElement, {
			key: "Tab",
			code: "Tab",
		});

		expect(notHandled).toBe(true);
		expect(document.activeElement).toBe(middle);
	});

	it("never hands focus to a control behind the backdrop", () => {
		render(<Fixture />);

		const dialog = screen.getByRole("dialog");
		const controls = controlsIn(dialog);
		const behindBefore = screen.getByTestId("behind-before");
		const behindAfter = screen.getByTestId("behind-after");

		// Walk both ends. Whatever the wrap does, it has to stay inside.
		for (const shiftKey of [false, true]) {
			for (const control of controls) {
				control.focus();
				fireEvent.keyDown(control, { key: "Tab", code: "Tab", shiftKey });

				expect(document.activeElement).not.toBe(behindBefore);
				expect(document.activeElement).not.toBe(behindAfter);
			}
		}
	});

	it("still closes on Escape, which is Base UI's to handle", async () => {
		// The wrap is scoped to Tab. Escape has to keep reaching Base UI or the
		// dialog stops being closable from the keyboard — the regression a
		// keydown handler on the popup could most easily cause.
		render(<ControlledFixture />);

		const dialog = screen.getByRole("dialog");
		const control = controlsIn(dialog)[0];
		control?.focus();

		fireEvent.keyDown(control as HTMLElement, {
			key: "Escape",
			code: "Escape",
		});

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("leaves focus where it is for keys that are not Tab", () => {
		render(<Fixture />);

		const dialog = screen.getByRole("dialog");
		const control = controlsIn(dialog)[0];
		control?.focus();

		for (const key of ["Escape", "Enter", "ArrowDown", "a"]) {
			fireEvent.keyDown(control as HTMLElement, { key, code: key });
			expect(document.activeElement).toBe(control);
		}
	});
});
