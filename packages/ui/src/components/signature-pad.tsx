"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { cn } from "@bfa-platform/ui/lib/utils";
import { useEffect, useRef } from "react";
import SignatureCanvas from "react-signature-canvas";

/**
 * The one new UI primitive the certifier wizard needs: a canvas the owner or
 * property manager signs on a phone (build-plan § 6.5 step 19). Everything
 * else in the wizard reuses an existing `packages/ui` component.
 *
 * Uncontrolled, like the canvas underneath it — a signature is a drawing,
 * not a value React re-renders from on every stroke. `value` only seeds the
 * canvas once, on mount (resuming a draft that already carries one);
 * `onChange` fires with the finished PNG data URI each time a stroke ends,
 * matching exactly what `submission-document.tsx`'s read-only `Signature`
 * renderer already expects (`value?.startsWith("data:image/")`).
 */
export function SignaturePad({
	value,
	onChange,
	onClear,
	className,
}: {
	value?: string | null;
	onChange: (dataUrl: string) => void;
	onClear: () => void;
	className?: string;
}) {
	const padRef = useRef<SignatureCanvas>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: seeds the canvas once from a resumed draft's stored signature, not on every `value` change
	useEffect(() => {
		if (value && padRef.current) padRef.current.fromDataURL(value);
	}, []);

	return (
		<div className={cn("flex flex-col gap-2", className)}>
			<div className="rounded-md border border-border bg-card">
				<SignatureCanvas
					ref={padRef}
					penColor="#1B242D"
					canvasProps={{
						className: "h-32 w-full touch-none",
						"aria-label": "Owner or property manager signature",
					}}
					onEnd={() => {
						const pad = padRef.current;
						if (pad && !pad.isEmpty()) {
							onChange(pad.getTrimmedCanvas().toDataURL("image/png"));
						}
					}}
				/>
			</div>
			<Button
				type="button"
				variant="secondary"
				size="sm"
				className="self-start"
				onClick={() => {
					padRef.current?.clear();
					onClear();
				}}
			>
				Clear signature
			</Button>
		</div>
	);
}
