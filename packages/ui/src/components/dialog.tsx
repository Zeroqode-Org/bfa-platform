"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@bfa-platform/ui/lib/utils";
import { XIcon } from "lucide-react";
import type * as React from "react";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

function DialogBackdrop({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
	return (
		<DialogPrimitive.Backdrop
			className={cn(
				"fixed inset-0 z-50 bg-[rgba(16,24,40,0.45)] transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * What Tab can land on inside an open dialog.
 *
 * Base UI's own focus guards are excluded deliberately: they are the thing the
 * wrap below exists to get ahead of, and treating one as a destination would
 * reintroduce the gap.
 */
const TABBABLE_SELECTOR = [
	"a[href]",
	"button",
	"input",
	"select",
	"textarea",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

function tabbablesIn(popup: HTMLElement) {
	return Array.from(
		popup.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
	).filter(
		(element) =>
			!element.hasAttribute("disabled") &&
			element.tabIndex >= 0 &&
			!element.hasAttribute("data-base-ui-focus-guard") &&
			// jsdom has no layout and no `checkVisibility`; there, presence in the
			// popup is as much as can be asked.
			(typeof element.checkVisibility !== "function" ||
				element.checkVisibility()),
	);
}

/**
 * Wraps Tab and Shift+Tab from the ends of the dialog back into it, in the
 * keydown itself.
 *
 * Base UI already traps focus, with a visually hidden guard either side of the
 * popup: tabbing off the last control lands on the trailing guard, whose focus
 * handler sends focus back to the first control. That redirect is deferred to
 * `requestAnimationFrame` (`enqueueFocus`), so for one frame the focus sits on
 * a guard that is outside the popup — and a second Tab arriving before that
 * frame lands walks straight out into the page behind the backdrop. A frame
 * that never arrives is not hypothetical: stub `requestAnimationFrame` and the
 * escape is deterministic, and a long task blocking the main thread starves it
 * the same way.
 *
 * Handling the wrap synchronously closes that window. It does not fight Base
 * UI — in the normal case the guards simply never get focus, and everything
 * else about the trap, including Escape, the backdrop and the returned focus,
 * is left to it. Anything other than Tab at an end is passed straight through,
 * so a `Select` popup (which portals out of this subtree and never reaches this
 * handler) and the segments of a date input keep their own key handling.
 */
function handleDialogTabWrap(event: React.KeyboardEvent<HTMLElement>) {
	if (event.key !== "Tab" || event.defaultPrevented) return;

	const popup = event.currentTarget;
	const items = tabbablesIn(popup);
	if (items.length === 0) return;

	const active = popup.ownerDocument.activeElement;
	const first = items[0];
	const last = items[items.length - 1];
	if (!first || !last) return;

	if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	} else if (event.shiftKey && active === first) {
		event.preventDefault();
		last.focus();
	}
}

function DialogContent({
	className,
	children,
	showClose = true,
	onKeyDown,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & {
	showClose?: boolean;
}) {
	return (
		<DialogPortal>
			<DialogBackdrop />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				onKeyDown={(event) => {
					handleDialogTabWrap(event);
					onKeyDown?.(event);
				}}
				className={cn(
					// A column rather than a grid so a dialog that opts into
					// `DialogBody` can hand the body the leftover height and keep its
					// header and footer where they are.
					"fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-lg outline-none",
					// Bounded to the viewport with a 1rem margin all round, and
					// scrollable by default so a dialog taller than the screen is
					// reachable rather than running off the bottom of it. `svh` is what
					// makes that hold on a phone, where `vh` measures the viewport as if
					// the browser chrome were not there.
					//
					// This default is the fallback for the short dialogs — the confirms
					// and the one- and two-field forms — which fit the screen and so
					// rarely scroll at all. A dialog with a body long enough to scroll
					// wants `DialogBody` and an `overflow-hidden` popup instead, so its
					// header and footer stay put.
					"max-h-[calc(100svh-2rem)] overflow-y-auto",
					"transition-all duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
					className,
				)}
				{...props}
			>
				{children}
				{showClose && (
					<DialogPrimitive.Close
						className="absolute top-4 right-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
						aria-label="Close"
					>
						<XIcon className="size-4" />
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex shrink-0 flex-col gap-1.5", className)}
			{...props}
		/>
	);
}

/**
 * The scrolling middle of a dialog, between a pinned header and a pinned
 * footer.
 *
 * Opt-in, and it comes as a pair: the `DialogContent` that holds one has to be
 * told `overflow-hidden`, so the popup clips instead of scrolling and this is
 * the only thing that moves. Without it there would be two scroll containers
 * and the footer would still leave the screen.
 *
 * `min-h-0` is what lets it shrink at all — a flex child's automatic minimum
 * size is its content, so a long form would otherwise push the footer past the
 * bottom of a popup that is already at its maximum height.
 *
 * `-m-1 p-1` buys 4px inside the clip box for the 2px focus rings on the
 * controls at its edges, and takes the same 4px back off the outside so the
 * spacing around it is unchanged.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-body"
			className={cn(
				"-m-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-1",
				className,
			)}
			{...props}
		/>
	);
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn(
				"flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className,
			)}
			{...props}
		/>
	);
}

function DialogTitle({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			className={cn("font-bold text-[17px] text-foreground", className)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			className={cn("text-[13px] text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogBackdrop,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
