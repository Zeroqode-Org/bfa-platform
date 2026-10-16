"use client";

import {
	isPreviewablePhotoPath,
	parsePhotoPath,
} from "@bfa-platform/api/lib/photo-rules";
import { ImageIcon } from "lucide-react";
import { useState } from "react";

/**
 * One attached photo, as an image when the browser can draw it and as a plain
 * "Photo attached" tile when it cannot.
 *
 * HEIC is never handed to `<img>`: most browsers outside Safari cannot decode
 * it, and a broken-image icon reads as a failed upload when the file is in
 * fact stored. JPEG and PNG are drawn, and fall back to the same tile if the
 * image still fails to load (an expired link, a file that is not what its
 * name said).
 */
export function PhotoThumbnail({
	path,
	src,
	alt,
	pendingLabel,
	imageClassName,
}: {
	/** The stored path; its extension decides whether a preview is attempted. */
	path: string;
	/** A blob: or signed URL to draw; absent while it is still being fetched. */
	src: string | undefined;
	alt: string;
	/** Shown for a previewable photo whose `src` has not arrived yet. */
	pendingLabel: string;
	imageClassName?: string;
}) {
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const previewable = isPreviewablePhotoPath(path);

	if (previewable && src && failedSrc !== src) {
		return (
			// biome-ignore lint/performance/noImgElement: a blob: or signed link to a private file, not an asset Next can optimise
			<img
				src={src}
				alt={alt}
				className={imageClassName}
				onError={() => setFailedSrc(src)}
			/>
		);
	}

	if (previewable && !src) {
		return (
			<span className="flex flex-col items-center gap-1 text-[12px] text-muted-foreground">
				<ImageIcon className="size-5" aria-hidden="true" />
				{pendingLabel}
			</span>
		);
	}

	const format = parsePhotoPath(path)?.extension.toUpperCase() ?? "Photo";

	return (
		<span
			role="img"
			aria-label={`${alt}, ${format}, no preview`}
			className="flex flex-col items-center gap-1 px-2 text-center text-[12px] text-muted-foreground"
		>
			<ImageIcon className="size-5" aria-hidden="true" />
			<span className="font-semibold text-foreground">Photo attached</span>
			<span className="text-[11px]">{format} · no preview</span>
		</span>
	);
}
