"use client";

import { PhotoThumbnail } from "@/components/certifier/wizard/photo-thumbnail";

/**
 * A submitted test's photos as thumbnails, each opening full size in a new
 * tab — never the storage path the record holds, which means nothing to a
 * reader (client, October 2026).
 *
 * The photos live in a private bucket, so the caller passes short-lived signed
 * links keyed by path; until one arrives its tile shows a placeholder rather
 * than a broken image.
 */
export function TestPhotos({
	photos,
	urls,
}: {
	photos: { label: string; path: string }[];
	urls: Record<string, string>;
}) {
	if (photos.length === 0) return null;

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] text-muted-foreground">Photos</span>
			<div className="grid grid-cols-2 gap-3">
				{photos.map(({ label, path }) => {
					const url = urls[path];
					const tile = (
						<PhotoThumbnail
							key={path}
							path={path}
							src={url}
							alt={label}
							pendingLabel={label}
							imageClassName="size-full object-cover"
						/>
					);
					const frame =
						"flex h-32 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted";

					// `PhotoThumbnail` falls back to an "attached" tile for a format the
					// browser cannot draw (HEIC outside Safari) or an expired link.
					return url ? (
						<a
							key={path}
							href={url}
							target="_blank"
							rel="noreferrer"
							className={frame}
						>
							{tile}
						</a>
					) : (
						<div key={path} className={frame}>
							{tile}
						</div>
					);
				})}
			</div>
		</div>
	);
}
