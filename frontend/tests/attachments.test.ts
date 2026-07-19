import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentError,
  assertAttachmentTotal,
  attachmentByteSize,
  attachmentPreviewUrl,
  createImageAttachment,
  isLocalImageAttachment,
  materializeImageAttachment,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  releaseImageAttachment,
} from "../src/attachments";

function installObjectUrlMocks(): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  const create = vi.fn(() => "blob:attachment-preview");
  const revoke = vi.fn();
  const MockUrl = class extends URL {};
  Object.defineProperties(MockUrl, {
    createObjectURL: { value: create },
    revokeObjectURL: { value: revoke },
  });
  vi.stubGlobal("URL", MockUrl);
  vi.stubGlobal("createImageBitmap", vi.fn(() => Promise.reject(new Error("decode unavailable"))));
  return { create, revoke };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reference image preparation", () => {
  it("keeps a blob preview until the attachment crosses the send boundary", async () => {
    const { create, revoke } = installObjectUrlMocks();
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const file = new File([new Uint8Array([1, 2, 3, 4])], "reference.png", { type: "image/png" });
    const attachment = await createImageAttachment(file, "attachment-1");

    expect(attachment).toMatchObject({ id: "attachment-1", name: "reference.png", mimeType: "image/png", size: 4 });
    expect(isLocalImageAttachment(attachment)).toBe(true);
    if (!isLocalImageAttachment(attachment)) throw new Error("Expected a local attachment");
    expect(attachment.blob).toBeInstanceOf(Blob);
    expect(attachmentPreviewUrl(attachment)).toBe("blob:attachment-preview");
    expect(create).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();

    const first = materializeImageAttachment(attachment);
    const second = materializeImageAttachment(attachment);
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      id: "attachment-1",
      name: "reference.png",
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(read).toHaveBeenCalledOnce();

    releaseImageAttachment(attachment);
    releaseImageAttachment(attachment);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:attachment-preview");
  });

  it("keeps persisted data URL attachments compatible without re-encoding", async () => {
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const attachment = {
      id: "persisted-1",
      name: "persisted.png",
      dataUrl: "data:image/png;base64,AQIDBA==",
      mimeType: "image/png",
      size: 4,
    };

    expect(attachmentPreviewUrl(attachment)).toBe(attachment.dataUrl);
    await expect(materializeImageAttachment(attachment)).resolves.toEqual(attachment);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects source images above the browser-side safety limit", async () => {
    const file = new File([new Uint8Array(MAX_SOURCE_IMAGE_BYTES + 1)], "huge.png", { type: "image/png" });
    await expect(createImageAttachment(file, "attachment-2")).rejects.toMatchObject({
      code: "source_too_large",
      details: { name: "huge.png", limitBytes: MAX_SOURCE_IMAGE_BYTES },
    });
  });

  it("enforces a combined encoded payload budget", () => {
    const large = { id: "large", name: "large.png", dataUrl: "data:image/png;base64,", size: 17 * 1024 * 1024 };
    expect(attachmentByteSize(large)).toBe(17 * 1024 * 1024);
    try {
      assertAttachmentTotal([large]);
      throw new Error("Expected the attachment total to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AttachmentError);
      expect(error).toMatchObject({
        code: "total_too_large",
        details: { totalBytes: 17 * 1024 * 1024, limitBytes: MAX_TOTAL_ATTACHMENT_BYTES },
      });
    }
  });
});
