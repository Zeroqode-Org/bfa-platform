// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { signInNoticeFor } from "@/lib/sign-in-notice";

import { SignInNotice } from "./sign-in-notice";

afterEach(() => {
	cleanup();
});

function renderNotice(key: string) {
	const notice = signInNoticeFor(key);
	if (!notice) throw new Error(`no notice for ${key}`);

	render(<SignInNotice notice={notice} />);

	return notice;
}

describe("SignInNotice", () => {
	it("renders the title and the explanation together", () => {
		const notice = renderNotice("blocked");

		const status = screen.getByRole("status");
		expect(status.textContent).toContain(notice.title);
		expect(status.textContent).toContain(notice.description);
	});

	it("announces as a status rather than an alert", () => {
		// It renders on page load, not in response to something the person just
		// did. An alert interrupts; a status is announced in turn. The form's own
		// submit errors stay `role="alert"`, because those are a response to an
		// action.
		renderNotice("blocked");

		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("paints a block in the danger tint pair, never a solid fill", () => {
		renderNotice("blocked");

		const className = screen.getByRole("status").className;
		expect(className).toContain("bg-danger-bg");
		expect(className).toContain("text-danger");
		// Tokens only — a hex value here would be a hardcoded colour.
		expect(className).not.toMatch(/#[0-9a-f]{3,6}/i);
	});

	it("paints an unfinished account in the warning pair instead", () => {
		// Two different problems needing two different actions should not look
		// identical.
		renderNotice("no_profile");

		const className = screen.getByRole("status").className;
		expect(className).toContain("bg-warning-bg");
		expect(className).toContain("text-warning");
	});

	it("hides its icon from assistive technology", () => {
		// The icon repeats the tone the words already carry.
		const { container } = render(
			<SignInNotice
				notice={{
					tone: "danger",
					title: "Title.",
					description: "Description.",
				}}
			/>,
		);

		const icon = container.querySelector("svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
	});
});
