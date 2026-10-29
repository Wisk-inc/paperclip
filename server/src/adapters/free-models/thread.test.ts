import { describe, expect, it, vi } from "vitest";

const drawing = vi.hoisted(() => ({ image: vi.fn() }));

vi.mock("@paperclipai/shared/puter-ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@paperclipai/shared/puter-ai")>();
  return { ...real, puterImage: drawing.image };
});

const { drawAndUploadImage } = await import("./thread.js");

function uploadApi() {
  return {
    request: vi.fn(),
    json: vi.fn(async () => ({ id: "att-1", contentPath: "/api/attachments/att-1/content" })),
  } as unknown as Parameters<typeof drawAndUploadImage>[0];
}

describe("drawAndUploadImage", () => {
  it("keeps the whole prompt with the picture, so Draw again asks for the same one", async () => {
    drawing.image.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    const prompt =
      "A watercolor of Port Antonio at golden hour: fishing boats pulled up on the sand, children playing football by the water, palm trees bending in the breeze, the Blue Mountains hazy behind";
    const drawn = await drawAndUploadImage(uploadApi(), "company-1", "issue-1", "run-12345678", "test-image-model" as never, prompt);
    expect(prompt.length).toBeGreaterThan(80);
    expect(drawn.markdown).toBe(`![${prompt}](/api/attachments/att-1/content)`);
  });

  it("keeps the embed whole when the prompt has brackets, backslashes or line breaks", async () => {
    drawing.image.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" });
    const drawn = await drawAndUploadImage(uploadApi(), "company-1", "issue-1", "run-12345678", "test-image-model" as never, "A sign that says [OPEN]\\\nin neon");
    expect(drawn.markdown).toBe("![A sign that says OPEN in neon](/api/attachments/att-1/content)");
  });
});
