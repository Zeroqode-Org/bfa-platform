"use client";

import { parsePhotoPath } from "@bfa-platform/api/lib/photo-rules";
import { cn } from "@bfa-platform/ui/lib/utils";
import { ImageIcon } from "lucide-react";
import { useState } from "react";

/**
 * One attached photo, as an image when the browser can draw it and as a plain
 * "Photo attached" tile when it cannot.
 *
 * Every format is tried, HEIC included: Safari draws HEIC, most other browsers
 * do not. The image stays hidden until it has loaded, so a browser that cannot
 * decode it never shows a broken-image icon — which would read as a failed
 * upload when the file is in fact stored — and falls back to the tile instead.
 * The same happens for an expired link or a file that is not what it claims.
 * (Photos uploaded through the wizard are normally JPEG already: it converts
 * HEIC before upload where the browser can, see `prepare-photo.ts`.)
 */
export function PhotoThumbnail({
	path,
	src,
	alt,
	pendingLabel,
	imageClassName,
}: {
	/** The stored path; its extension names the format on the fallback tile. */
	path: string;
	/** A blob: or signed URL to draw; absent while it is still being fetched. */
	src: string | undefined;
	alt: string;
	/** Shown while there is no image to show yet. */
	pendingLabel: string;
	imageClassName?: string;
}) {
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

	if (!src || failedSrc !== src) {
		const loaded = Boolean(src) && loadedSrc === src;

		return (
			<>
				{loaded ? null : (
					<span className="flex flex-col items-center gap-1 text-[12px] text-muted-foreground">
						<ImageIcon className="size-5" aria-hidden="true" />
						{pendingLabel}
					</span>
				)}
				{src ? (
					// biome-ignore lint/performance/noImgElement: a blob: or signed link to a private file, not an asset Next can optimise
					<img
						src={src}
						alt={alt}
						className={cn(imageClassName, !loaded && "hidden")}
						onLoad={() => setLoadedSrc(src)}
						onError={() => setFailedSrc(src)}
					/>
				) : null}
			</>
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
