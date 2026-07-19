import type { ChatAttachment, WireAttachment } from "./contracts";

export const MAX_ATTACHMENTS = 8;
export const MAX_SOURCE_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 1536;
const REENCODE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const materializedAttachments = new WeakMap<object, Promise<WireAttachment>>();
const previewReferences = new Map<string, number>();
const releasedPreviews = new Set<string>();

export type AttachmentErrorCode =
  | "read_failed"
  | "source_too_large"
  | "optimized_too_large"
  | "data_unavailable"
  | "total_too_large";

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    readonly details: { name?: string; limitBytes?: number; totalBytes?: number } = {},
  ) {
    super(code);
    this.name = "AttachmentError";
  }
}

export interface LocalImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  previewUrl: string;
}

export type PreparedImageAttachment = LocalImageAttachment | ChatAttachment;

export function isLocalImageAttachment(attachment: PreparedImageAttachment): attachment is LocalImageAttachment {
  return "blob" in attachment;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AttachmentError("read_failed"));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      return null;
    }
  }
  if (typeof Image === "undefined" || typeof URL?.createObjectURL !== "function") return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error(`Could not decode ${file.name}`));
      candidate.src = objectUrl;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(objectUrl) };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
}

async function optimizedBlob(file: File): Promise<Blob> {
  const decoded = await decodeImage(file);
  if (!decoded) return file;
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(decoded.width, decoded.height));
    if (scale === 1 && file.size <= REENCODE_THRESHOLD_BYTES) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const encoded = await canvasBlob(canvas);
    return encoded && encoded.size < file.size ? encoded : file;
  } finally {
    decoded.close();
  }
}

export function attachmentByteSize(attachment: PreparedImageAttachment): number {
  if (Number.isFinite(attachment.size)) return Number(attachment.size);
  const encoded = ("dataUrl" in attachment ? attachment.dataUrl : "")?.split(",", 2)[1] ?? "";
  return Math.max(0, Math.floor(encoded.length * 0.75));
}

export function totalAttachmentBytes(attachments: PreparedImageAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachmentByteSize(attachment), 0);
}

export async function createImageAttachment(file: File, attachmentId: string): Promise<PreparedImageAttachment> {
  if (!file.type.startsWith("image/")) throw new Error("Only image files can be attached.");
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new AttachmentError("source_too_large", { name: file.name, limitBytes: MAX_SOURCE_IMAGE_BYTES });
  const blob = await optimizedBlob(file);
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("optimized_too_large", { name: file.name, limitBytes: MAX_ATTACHMENT_BYTES });
  const common = {
    id: attachmentId,
    name: file.name,
    mimeType: blob.type || file.type,
    size: blob.size,
  };
  if (typeof URL?.createObjectURL === "function") {
    const previewUrl = URL.createObjectURL(blob);
    previewReferences.set(previewUrl, 1);
    releasedPreviews.delete(previewUrl);
    return { ...common, blob, previewUrl };
  }
  return {
    ...common,
    dataUrl: await readBlobAsDataUrl(blob),
  };
}

export function attachmentPreviewUrl(attachment: PreparedImageAttachment): string {
  return attachment.previewUrl || ("dataUrl" in attachment ? attachment.dataUrl : "") || "";
}

export function displayImageAttachment(attachment: PreparedImageAttachment): ChatAttachment {
  if ("dataUrl" in attachment && attachment.dataUrl) return attachment;
  return {
    id: attachment.id,
    name: attachment.name,
    previewUrl: attachmentPreviewUrl(attachment),
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

export function materializeImageAttachment(attachment: PreparedImageAttachment): Promise<WireAttachment> {
  const existing = materializedAttachments.get(attachment);
  if (existing) return existing;
  const pending = (async () => {
    const dataUrl = "dataUrl" in attachment && attachment.dataUrl
      ? attachment.dataUrl
      : isLocalImageAttachment(attachment)
        ? await readBlobAsDataUrl(attachment.blob)
        : "";
    if (!dataUrl) throw new AttachmentError("data_unavailable", { name: attachment.name });
    return {
      id: attachment.id,
      name: attachment.name,
      dataUrl,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
  })();
  materializedAttachments.set(attachment, pending);
  void pending.catch(() => materializedAttachments.delete(attachment));
  return pending;
}

export async function materializeImageAttachments(attachments: PreparedImageAttachment[]): Promise<WireAttachment[]> {
  const materialized: WireAttachment[] = [];
  for (const attachment of attachments) materialized.push(await materializeImageAttachment(attachment));
  return materialized;
}

export function retainImageAttachment(attachment: { previewUrl?: string }): void {
  if (!attachment.previewUrl || !previewReferences.has(attachment.previewUrl) || releasedPreviews.has(attachment.previewUrl)) return;
  previewReferences.set(attachment.previewUrl, (previewReferences.get(attachment.previewUrl) ?? 0) + 1);
}

export function retainImageAttachments(attachments: Array<{ previewUrl?: string }>): void {
  attachments.forEach(retainImageAttachment);
}

export function releaseImageAttachment(attachment: { previewUrl?: string }): void {
  const previewUrl = attachment.previewUrl;
  if (!previewUrl || releasedPreviews.has(previewUrl)) return;
  const references = previewReferences.get(previewUrl) ?? 1;
  if (references > 1) {
    previewReferences.set(previewUrl, references - 1);
    return;
  }
  previewReferences.delete(previewUrl);
  releasedPreviews.add(previewUrl);
  if (typeof URL?.revokeObjectURL === "function") URL.revokeObjectURL(previewUrl);
}

export function releaseImageAttachments(attachments: Array<{ previewUrl?: string }>): void {
  attachments.forEach(releaseImageAttachment);
}

export function assertAttachmentTotal(attachments: PreparedImageAttachment[]): void {
  const totalBytes = totalAttachmentBytes(attachments);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AttachmentError("total_too_large", { totalBytes, limitBytes: MAX_TOTAL_ATTACHMENT_BYTES });
  }
}
