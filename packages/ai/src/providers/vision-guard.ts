import { $env } from "@oh-my-pi/pi-utils";
import type { Api, ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	model: Model<Api>,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const allImages = content.filter((block): block is ImageContent => block.type === "image");
	// Per block, so a video's contact sheet survives on a `video`-only model
	// while a user-attached picture on that same message does not.
	const imageBlocks = allImages.filter(block => allowsImageBlockOnWire(model, block));
	return {
		textBlocks,
		imageBlocks,
		omittedImages: imageBlocks.length < allImages.length,
	};
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(NON_VISION_IMAGE_PLACEHOLDER);
	}
	return parts.join("\n");
}

/**
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions" | "openrouter">): boolean {
	if (!model.input.includes("image")) return false;
	if (model.compat.stripImageInput) return false;
	return true;
}

/**
 * Whether the transport that will carry `model` sends image content on the wire.
 *
 * The `pi-native` transport forwards the original context (images included) to
 * the gateway, which resolves its own model server-side, so the Chat
 * Completions guard below never runs client-side and the declared input
 * applies. Otherwise the OpenAI Chat Completions path applies the text-only
 * guard, as does the OpenRouter chat fallback (`PI_OPENROUTER_RESPONSES=0`,
 * which dispatches `openrouter` models through `streamOpenAICompletions`);
 * every other API ships the modalities the model declares. Callers that report
 * or gate on the wire (for example the `omp models` table) read this
 * predicate; declared capability reads `model.input`.
 */
export function sendsImageInputOnWire(model: Model<Api>): boolean {
	if (model.transport === "pi-native") return model.input.includes("image");
	if (isGuardedCompletionsTransport(model)) return isOpenAICompletionsVisionSupported(model);
	return model.input.includes("image");
}

/**
 * Whether this image block may go on the wire for `model` — the per-block half
 * of {@link sendsImageInputOnWire}, for gates that walk content parts.
 *
 * A clip reaches the model as its reduced contact sheet, so a model that
 * advertises `video` reads that sheet without also advertising `image`. The
 * key is the BLOCK's provenance (`videoPreview`), not the modality list: the
 * list cannot tell a video's contact sheet from a picture the user attached,
 * and exempting images wholesale would hand a video-only model a picture it
 * still rejects. `compat.stripImageInput` means the endpoint 400s on any
 * `image_url` and overrides both.
 */
export function allowsImageBlockOnWire(model: Model<Api>, block: ImageContent): boolean {
	if (sendsImageInputOnWire(model)) return true;
	// `compat` is optional and its union members do not all declare
	// `stripImageInput` (DevinCompat has no such field), so read it structurally
	// rather than assuming the property exists on every variant.
	const compatStrip = (model.compat as { stripImageInput?: boolean } | undefined)?.stripImageInput;
	if (compatStrip) return false;
	return block.videoPreview === true && model.input.includes("video");
}

/** True for the transports that encode through the Chat Completions guard. */
function isGuardedCompletionsTransport(model: Model<Api>): model is Model<"openai-completions" | "openrouter"> {
	if (model.api === "openai-completions") return true;
	return model.api === "openrouter" && $env.PI_OPENROUTER_RESPONSES === "0";
}
