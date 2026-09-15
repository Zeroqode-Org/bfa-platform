// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NoticeTemplate } from "./notice-types";

/**
 * The notice-template editor: what it renders from the server's list, what a
 * save sends, what the preview substitutes, and what a read-only role is shown
 * instead of the write controls.
 *
 * The tRPC module is mocked because importing it for real would give the
 * queries a live HTTP link. `queryOptions`/`mutationOptions` are thin
 * passthroughs in the real proxy too, so the component still runs against
 * genuine React Query state — only the transport is replaced.
 */

const listFn = vi.fn();
const sampleFn = vi.fn();
const upsertFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		notices: {
			listNoticeTemplates: {
				queryOptions: () => ({
					queryKey: ["notices", "listNoticeTemplates"],
					queryFn: () => listFn(),
				}),
				queryKey: () => ["notices", "listNoticeTemplates"],
			},
			getNoticePreviewSample: {
				queryOptions: () => ({
					queryKey: ["notices", "getNoticePreviewSample"],
					queryFn: () => sampleFn(),
				}),
			},
			upsertNoticeTemplate: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["notices", "upsertNoticeTemplate"],
					mutationFn: (input: unknown) => upsertFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { NoticeTemplatesEditor } = await import("./notice-templates-editor");

function template(
	noticeType: NoticeTemplate["noticeType"],
	label: string,
	overrides: Partial<NoticeTemplate> = {},
): NoticeTemplate {
	return {
		noticeType,
		label,
		subject: `${label} default subject`,
		body: `${label} default body`,
		isCustomized: false,
		defaultSubject: `${label} default subject`,
		defaultBody: `${label} default body`,
		updatedAt: null,
		...overrides,
	} as NoticeTemplate;
}

const templates: NoticeTemplate[] = [
	template("reminder", "Reminder", {
		subject: "Due {{due_date}}",
		body: "Hello {{customer_name}}, your {{bfa_type}} at {{service_address}} is due.",
		isCustomized: true,
	}),
	template("late_notice_1", "Late Notice 1"),
	template("late_notice_2", "Late Notice 2"),
	template("final_notice", "Final Notice"),
];

const sampleValues = {
	customer_name: "Sample Customer",
	wp_name: "Harbor Water Works",
	bfa_type: "RP",
	bin: "BIN-000123",
	service_address: "100 Sample Street",
	due_date: "2026-10-01",
};

function renderEditor({ canEdit = true }: { canEdit?: boolean } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	render(
		<QueryClientProvider client={queryClient}>
			<NoticeTemplatesEditor canEdit={canEdit} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listFn.mockReset();
	sampleFn.mockReset();
	upsertFn.mockReset();
	listFn.mockResolvedValue(templates);
	sampleFn.mockResolvedValue({ values: sampleValues });
	upsertFn.mockImplementation((input: { noticeType: string }) =>
		Promise.resolve({
			...input,
			id: "row-1",
			label: "Reminder",
			isCustomized: true,
		}),
	);
});

afterEach(() => {
	cleanup();
});

describe("NoticeTemplatesEditor", () => {
	it("shows a loading state before the templates arrive", () => {
		listFn.mockReturnValue(new Promise(() => {}));
		renderEditor();

		expect(screen.queryByRole("tab", { name: /reminder/i })).toBeNull();
	});

	it("renders all four notice types from the server's list", async () => {
		renderEditor();

		expect(await screen.findByRole("tab", { name: /Reminder/ })).toBeTruthy();
		expect(screen.getAllByRole("tab")).toHaveLength(4);
		for (const label of ["Late Notice 1", "Late Notice 2", "Final Notice"]) {
			expect(screen.getByRole("tab", { name: new RegExp(label) })).toBeTruthy();
		}
	});

	it("reports a load failure and offers a retry", async () => {
		listFn.mockRejectedValue(new Error("network is down"));
		renderEditor();

		expect(
			await screen.findByText(/couldn’t load notice templates/i),
		).toBeTruthy();
		expect(screen.getByText("network is down")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
	});

	it("says which templates are the platform's and which are the purveyor's", async () => {
		renderEditor();

		// The first tab opens by default and is the customized one.
		expect(await screen.findByText("Customized")).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: /Late Notice 1/ }));

		expect(await screen.findByText("Platform default")).toBeTruthy();
	});

	it("loads the platform default text into the editor for an untouched type", async () => {
		renderEditor();

		fireEvent.click(await screen.findByRole("tab", { name: /Final Notice/ }));

		const subject = (await screen.findByLabelText(
			"Subject",
		)) as HTMLInputElement;

		// Not blank: the fallback is what would be sent, so it is what is edited.
		expect(subject.value).toBe("Final Notice default subject");
	});

	it("substitutes the sample values in the preview", async () => {
		renderEditor();

		await screen.findByLabelText("Subject");

		await waitFor(() => {
			expect(screen.getByText("Due 2026-10-01")).toBeTruthy();
		});
		expect(
			screen.getByText(
				"Hello Sample Customer, your RP at 100 Sample Street is due.",
			),
		).toBeTruthy();
	});

	it("updates the preview as the text is edited", async () => {
		renderEditor();

		const body = await screen.findByLabelText("Message");
		fireEvent.change(body, {
			target: { value: "Dear {{customer_name}} of {{wp_name}}." },
		});

		expect(
			await screen.findByText("Dear Sample Customer of Harbor Water Works."),
		).toBeTruthy();
	});

	it("warns in the preview about a placeholder that will not resolve", async () => {
		renderEditor();

		const body = await screen.findByLabelText("Message");
		fireEvent.change(body, { target: { value: "Hello {{custmer_name}}" } });

		// Left visible rather than blanked — it appears in the rendered preview and
		// again in the warning that names it, which is the point of both.
		expect(
			(await screen.findAllByText(/\{\{custmer_name\}\}/)).length,
		).toBeGreaterThan(0);
		expect(screen.getByRole("alert").textContent).toContain(
			"is not a supported value",
		);
	});

	it("inserts a placeholder into the message at the caret", async () => {
		renderEditor();

		const body = (await screen.findByLabelText(
			"Message",
		)) as HTMLTextAreaElement;
		fireEvent.change(body, { target: { value: "Hello " } });
		body.focus();
		fireEvent.focus(body);
		body.setSelectionRange(6, 6);

		fireEvent.click(
			screen.getByRole("button", { name: /Insert \{\{customer_name\}\}/ }),
		);

		await waitFor(() => {
			expect(body.value).toBe("Hello {{customer_name}}");
		});
	});

	it("lists every supported variable in the reference panel", async () => {
		renderEditor();

		await screen.findByLabelText("Subject");

		for (const placeholder of [
			"customer_name",
			"wp_name",
			"bfa_type",
			"bin",
			"service_address",
			"due_date",
		]) {
			expect(
				screen.getByRole("button", {
					name: new RegExp(`Insert \\{\\{${placeholder}\\}\\}`),
				}),
			).toBeTruthy();
		}
	});

	it("saves the edited subject and body for the selected type", async () => {
		renderEditor();

		const subject = await screen.findByLabelText("Subject");
		fireEvent.change(subject, { target: { value: "Our own subject" } });

		fireEvent.click(screen.getByRole("button", { name: /save template/i }));

		await waitFor(() => {
			expect(upsertFn).toHaveBeenCalledWith({
				noticeType: "reminder",
				subject: "Our own subject",
				body: templates[0]?.body,
			});
		});
	});

	it("will not save until something has changed", async () => {
		renderEditor();

		await screen.findByLabelText("Subject");

		expect(
			(
				screen.getByRole("button", {
					name: /save template/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("shows the server's refusal inline rather than as a toast", async () => {
		upsertFn.mockRejectedValue(new Error("Water Purveyor admin only"));
		renderEditor();

		const subject = await screen.findByLabelText("Subject");
		fireEvent.change(subject, { target: { value: "Our own subject" } });
		fireEvent.click(screen.getByRole("button", { name: /save template/i }));

		await waitFor(() => {
			expect(
				screen
					.getAllByRole("alert")
					.some((node) =>
						node.textContent?.includes("Water Purveyor admin only"),
					),
			).toBe(true);
		});
	});

	it("reports a blank subject at the field and sends nothing", async () => {
		renderEditor();

		const subject = await screen.findByLabelText("Subject");
		fireEvent.change(subject, { target: { value: "   " } });
		fireEvent.click(screen.getByRole("button", { name: /save template/i }));

		const message = screen.getByText("Subject is required.");
		expect(subject.getAttribute("aria-invalid")).toBe("true");
		expect(subject.getAttribute("aria-describedby")).toBe(message.id);
		expect(document.activeElement).toBe(subject);
		expect(upsertFn).not.toHaveBeenCalled();

		fireEvent.change(subject, { target: { value: "Due soon" } });
		expect(screen.queryByText("Subject is required.")).toBeNull();
	});

	it("refuses an unsupported placeholder at the field before the server sees it", async () => {
		renderEditor();

		const body = await screen.findByLabelText("Message");
		fireEvent.change(body, { target: { value: "Hello {{custmer_name}}" } });
		fireEvent.click(screen.getByRole("button", { name: /save template/i }));

		expect(body.getAttribute("aria-invalid")).toBe("true");
		expect(upsertFn).not.toHaveBeenCalled();
	});

	it("counts the message against the server's limit", async () => {
		renderEditor();

		const body = await screen.findByLabelText("Message");
		fireEvent.change(body, { target: { value: "x".repeat(5001) } });

		const counter = screen.getByText("5,001 / 5,000 characters");
		expect(body.getAttribute("aria-describedby")).toContain(counter.id);

		fireEvent.click(screen.getByRole("button", { name: /save template/i }));
		expect(screen.getByText("Must be 5,000 characters or fewer.")).toBeTruthy();
		expect(upsertFn).not.toHaveBeenCalled();
	});

	it("reports saving while the write is in flight", async () => {
		upsertFn.mockReturnValue(new Promise(() => {}));
		renderEditor();

		const subject = await screen.findByLabelText("Subject");
		fireEvent.change(subject, { target: { value: "Saving this" } });
		fireEvent.click(screen.getByRole("button", { name: /save template/i }));

		expect(
			await screen.findByRole("button", { name: /saving…/i }),
		).toBeTruthy();
	});

	it("hides every write control from a read-only role and says why", async () => {
		renderEditor({ canEdit: false });

		await screen.findByLabelText("Subject");

		expect(screen.queryByRole("button", { name: /save template/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /reset to platform default/i }),
		).toBeNull();
		expect(screen.getByText(/only a wp admin/i)).toBeTruthy();
		expect(
			(screen.getByLabelText("Subject") as HTMLInputElement).disabled,
		).toBe(true);
	});

	it("offers no enable or disable switch for a notice type", async () => {
		renderEditor();

		await screen.findByLabelText("Subject");

		// The column exists and stays unwired: automated notices are switched on
		// per purveyor by the Super-Admin, not per type by the WP.
		expect(screen.queryByRole("switch")).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByText(/enabled/i)).toBeNull();
	});
});
