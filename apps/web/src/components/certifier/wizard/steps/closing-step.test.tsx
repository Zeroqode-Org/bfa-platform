// @vitest-environment jsdom

import { MAX_PHOTO_BYTES } from "@bfa-platform/api/lib/photo-rules";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The closing block's photo picker: what it lets through to the server, and
 * what it refuses before an upload URL is ever asked for.
 *
 * tRPC and the Supabase browser client are mocked — the first would open a live
 * HTTP link, the second validates env vars at import and would upload real
 * bytes. `mutationOptions`/`queryOptions` are thin passthroughs in the real
 * proxy too, so React Query state is still genuine.
 */

const DRAFT = "11111111-1111-4111-8111-111111111111";
const WP = "22222222-2222-4222-8222-222222222222";
const UUID = "33333333-3333-4333-8333-333333333333";

const getUploadUrl = vi.fn();
const getPhotoUrls = vi.fn();
const uploadToSignedUrl = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		certifierWizard: {
			getPhotoUploadUrl: {
				mutationOptions: (options: Record<string, unknown> = {}) => ({
					...options,
					mutationKey: ["certifierWizard", "getPhotoUploadUrl"],
					mutationFn: (input: unknown) => getUploadUrl(input),
				}),
			},
			getPhotoUrls: {
				pathFilter: () => ({ queryKey: [["certifierWizard", "getPhotoUrls"]] }),
				queryOptions: (input: { paths: string[] }) => ({
					queryKey: ["certifierWizard", "getPhotoUrls", input],
					queryFn: () => getPhotoUrls(input),
				}),
			},
		},
	},
}));

vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({
		storage: { from: () => ({ uploadToSignedUrl }) },
	}),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { PhotoUpload } = await import("./closing-step");

/** Owns `photoPaths` the way the wizard shell does, so an upload shows up. */
function Harness({ initial = [] }: { initial?: string[] }) {
	const [paths, setPaths] = useState(initial);

	return (
		<PhotoUpload
			draftId={DRAFT}
			waterPurveyorId={WP}
			photoPaths={paths}
			onChange={setPaths}
		/>
	);
}

function renderUpload(initial?: string[]) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});

	return render(
		<QueryClientProvider client={queryClient}>
			<Harness initial={initial} />
		</QueryClientProvider>,
	);
}

/** The first bytes of each format, padded to 32 — what `preparePhoto` sniffs. */
const pad = (head: number[]) => [...head, ...Array(32 - head.length).fill(0)];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const BYTES = {
	jpg: pad([0xff, 0xd8, 0xff, 0xe0]),
	png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	heic: pad([
		0,
		0,
		0,
		0x18,
		...ascii("ftyp"),
		...ascii("heic"),
		0,
		0,
		0,
		0,
		...ascii("mif1"),
		...ascii("heic"),
	]),
	pdf: pad(ascii("%PDF-1.4")),
};

/** The content a file's name implies, unless `content` says otherwise. */
function file(
	name: string,
	type: string,
	size?: number,
	content?: keyof typeof BYTES,
) {
	const extension = name.split(".").pop()?.toLowerCase();
	const kind =
		content ??
		(extension === "jpeg" ? "jpg" : (extension as keyof typeof BYTES));
	const picked = new File([new Uint8Array(BYTES[kind] ?? BYTES.pdf)], name, {
		type,
	});
	if (size !== undefined)
		Object.defineProperty(picked, "size", { value: size });

	return picked;
}

function pick(picked: File) {
	const input = screen.getByLabelText(/Add photo/) as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: [picked],
		configurable: true,
	});
	fireEvent.change(input);
}

beforeEach(() => {
	let next = 0;
	getUploadUrl.mockImplementation(async (input: { extension: string }) => ({
		token: "signed-token",
		path: `${DRAFT}/${UUID.slice(0, -1)}${next++}.${input.extension}`,
	}));
	getPhotoUrls.mockResolvedValue({});
	uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });
	URL.createObjectURL = vi.fn(() => "blob:preview");
	URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PhotoUpload", () => {
	it("offers only the accepted formats in the picker, with camera and gallery both", () => {
		renderUpload();

		// No `capture`: a phone then offers its camera *and* its photo library.
		expect(screen.getByLabelText(/Add photo/).hasAttribute("capture")).toBe(
			false,
		);

		const accept =
			(screen.getByLabelText(/Add photo/) as HTMLInputElement).accept ?? "";
		expect(accept.split(",").sort()).toEqual(
			[
				".heic",
				".jpeg",
				".jpg",
				".png",
				"image/heic",
				"image/jpeg",
				"image/png",
			].sort(),
		);
	});

	it.each([
		["IMG_1.jpg", "image/jpeg", "jpg", "image/jpeg"],
		["IMG_1.JPEG", "image/jpeg", "jpg", "image/jpeg"],
		["scan.png", "image/png", "png", "image/png"],
		["IMG_1.HEIC", "", "heic", "image/heic"],
	])(
		"checks %s, then asks for a URL with normalised metadata and uploads it as %s",
		async (name, type, extension, contentType) => {
			renderUpload();
			pick(file(name, type));

			await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalledTimes(1));

			expect(getUploadUrl).toHaveBeenCalledWith({
				id: DRAFT,
				waterPurveyorId: WP,
				extension,
				contentType,
				size: 32,
				keep: [],
			});

			const [path, token, body] = uploadToSignedUrl.mock.calls[0] ?? [];
			expect(path).toMatch(new RegExp(`\\.${extension}$`));
			expect(token).toBe("signed-token");
			// The canonical type travels on the uploaded Blob, not the browser's guess.
			expect((body as Blob).type).toBe(contentType);
			expect((body as Blob).size).toBe(32);
		},
	);

	it.each([
		["notes.pdf", "application/pdf"],
		["photo.webp", "image/webp"],
		["photo.jpg", "image/png"],
	])("refuses %s (%s) before asking for an upload URL", async (name, type) => {
		renderUpload();
		pick(file(name, type));

		expect(
			await screen.findByText("Supported formats are HEIC, PNG and JPG/JPEG."),
		).toBeTruthy();
		expect(getUploadUrl).not.toHaveBeenCalled();
		expect(uploadToSignedUrl).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /Remove photo/ })).toBeNull();
	});

	it("refuses a file whose content is not an image, whatever its name", async () => {
		renderUpload();
		pick(file("scan.jpg", "image/jpeg", undefined, "pdf"));

		expect(
			await screen.findByText("Supported formats are HEIC, PNG and JPG/JPEG."),
		).toBeTruthy();
		expect(getUploadUrl).not.toHaveBeenCalled();
	});

	it("uploads a JPEG named .heic as the JPEG it is", async () => {
		renderUpload();
		pick(file("IMG_1.heic", "image/heic", undefined, "jpg"));

		await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalled());
		expect(getUploadUrl).toHaveBeenCalledWith(
			expect.objectContaining({ extension: "jpg", contentType: "image/jpeg" }),
		);
	});

	it("converts a HEIC to JPEG where the browser can decode it, scaled to fit", async () => {
		const close = vi.fn();
		const drawImage = vi.fn();
		const canvases: HTMLCanvasElement[] = [];
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => ({ width: 8000, height: 6000, close })),
		);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
			function (this: HTMLCanvasElement) {
				canvases.push(this);
				return { drawImage } as never;
			},
		);
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
			(callback, type) =>
				callback(new Blob([new Uint8Array(BYTES.jpg)], { type: type ?? "" })),
		);

		try {
			renderUpload();
			pick(file("IMG_1.HEIC", ""));

			await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalled());
			expect(getUploadUrl).toHaveBeenCalledWith(
				expect.objectContaining({
					extension: "jpg",
					contentType: "image/jpeg",
					size: 32,
				}),
			);
			const [path, , body] = uploadToSignedUrl.mock.calls[0] ?? [];
			expect(path).toMatch(/\.jpg$/);
			expect((body as Blob).type).toBe("image/jpeg");
			// 8000 × 6000 does not fit an iOS canvas; the longest side becomes 4000.
			expect([canvases[0]?.width, canvases[0]?.height]).toEqual([4000, 3000]);
			expect(drawImage).toHaveBeenCalledTimes(1);
			expect(close).toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		}
	});

	it("refuses a file over 25 MB before asking for an upload URL", async () => {
		renderUpload();
		pick(file("huge.jpg", "image/jpeg", MAX_PHOTO_BYTES + 1));

		expect(
			await screen.findByText("Each photo must be 25 MB or smaller."),
		).toBeTruthy();
		expect(getUploadUrl).not.toHaveBeenCalled();
		expect(uploadToSignedUrl).not.toHaveBeenCalled();
	});

	it("lets a file of exactly 25 MB through to the server", async () => {
		renderUpload();
		pick(file("big.jpg", "image/jpeg", MAX_PHOTO_BYTES));

		await waitFor(() =>
			expect(getUploadUrl).toHaveBeenCalledWith(
				expect.objectContaining({ size: MAX_PHOTO_BYTES }),
			),
		);
	});

	it("clears a refusal once a valid file is picked", async () => {
		renderUpload();
		pick(file("notes.pdf", "application/pdf"));
		await screen.findByRole("alert");

		pick(file("IMG_1.jpg", "image/jpeg"));

		await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalled());
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps a HEIC the browser cannot convert, and shows it as a tile rather than a broken <img>", async () => {
		renderUpload();
		pick(file("IMG_1.heic", "image/heic"));

		// No decoder here (as in Chrome): the HEIC goes up unchanged.
		await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalled());
		expect(getUploadUrl).toHaveBeenCalledWith(
			expect.objectContaining({ extension: "heic", contentType: "image/heic" }),
		);

		// The preview is tried, but stays hidden until it loads…
		const image = await screen.findByAltText("Attached 1 of 2");
		expect(image.className).toContain("hidden");
		expect(screen.getByText("Photo 1 added")).toBeTruthy();

		// …and when the browser cannot draw it, the tile takes its place.
		fireEvent.error(image);
		expect(
			await screen.findByRole("img", { name: /HEIC, no preview/ }),
		).toBeTruthy();
		expect(screen.getByText("Photo attached")).toBeTruthy();
		expect(document.querySelector("img")).toBeNull();
		expect(screen.getByRole("button", { name: "Remove photo 1" })).toBeTruthy();
	});

	it("shows a preview once it has loaded", async () => {
		renderUpload();
		pick(file("IMG_1.jpg", "image/jpeg"));

		const image = await screen.findByAltText("Attached 1 of 2");
		fireEvent.load(image);

		await waitFor(() => expect(image.className).not.toContain("hidden"));
		expect(screen.queryByText("Photo 1 added")).toBeNull();
	});

	it("previews a JPEG, and falls back to the tile if the browser cannot draw it", async () => {
		renderUpload();
		pick(file("IMG_1.jpg", "image/jpeg"));

		const image = await screen.findByAltText("Attached 1 of 2");
		expect(image.getAttribute("src")).toBe("blob:preview");

		fireEvent.error(image);

		expect(
			await screen.findByRole("img", { name: /JPG, no preview/ }),
		).toBeTruthy();
		expect(document.querySelector("img")).toBeNull();
	});

	it("removes a photo", async () => {
		renderUpload([`${DRAFT}/${UUID}.heic`]);

		fireEvent.click(screen.getByRole("button", { name: "Remove photo 1" }));

		expect(screen.queryByRole("button", { name: /Remove photo/ })).toBeNull();
	});

	it("takes no third photo", async () => {
		renderUpload([`${DRAFT}/${UUID}.heic`]);
		pick(file("IMG_2.png", "image/png"));

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Remove photo 2" }),
			).toBeTruthy(),
		);

		// Two attached: the add tile is gone, so there is nothing to pick into.
		expect(screen.queryByLabelText(/Add photo/)).toBeNull();
		expect(getUploadUrl).toHaveBeenCalledTimes(1);
		// The photo already attached was named as one to keep.
		expect(getUploadUrl).toHaveBeenCalledWith(
			expect.objectContaining({ keep: [`${DRAFT}/${UUID}.heic`] }),
		);
	});

	it("ignores a second pick while an upload is still running", async () => {
		let finish: (value: { token: string; path: string }) => void = () => {};
		getUploadUrl.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		renderUpload([`${DRAFT}/${UUID}.heic`]);

		// Both picks land before React re-renders with the input disabled.
		const input = screen.getByLabelText(/Add photo/) as HTMLInputElement;
		for (const name of ["first.jpg", "second.jpg"]) {
			Object.defineProperty(input, "files", {
				value: [file(name, "image/jpeg")],
				configurable: true,
			});
			fireEvent.change(input);
		}

		await waitFor(() => expect(getUploadUrl).toHaveBeenCalled());

		finish({
			token: "signed-token",
			path: `${DRAFT}/${UUID.slice(0, -1)}9.jpg`,
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Remove photo 2" }),
			).toBeTruthy(),
		);
		expect(getUploadUrl).toHaveBeenCalledTimes(1);
		expect(uploadToSignedUrl).toHaveBeenCalledTimes(1);
	});

	it("releases its previews when the step is left", async () => {
		const { unmount } = renderUpload();
		pick(file("IMG_1.jpg", "image/jpeg"));
		await screen.findByAltText("Attached 1 of 2");

		unmount();

		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
	});
});
