// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toPng: vi.fn(async () => "data:image/png;base64,test"),
  addImage: vi.fn(),
  addPage: vi.fn(),
  output: vi.fn(() => new Blob(["pdf"], { type: "application/pdf" })),
  triggerDownload: vi.fn(),
}));

vi.mock("dom-to-image-more", () => ({
  default: { toPng: mocks.toPng },
}));

vi.mock("jspdf", () => ({
  jsPDF: vi.fn(function MockPdf() {
    return {
      setFontSize: vi.fn(),
      setTextColor: vi.fn(),
      text: vi.fn(),
      addPage: mocks.addPage,
      addImage: mocks.addImage,
      output: mocks.output,
    };
  }),
}));

vi.mock("./download", () => ({
  triggerDownload: mocks.triggerDownload,
}));

import { captureSectionsAsPDF } from "./pdf";

describe("captureSectionsAsPDF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lays out and captures a section hidden by an inactive tab", async () => {
    const section = document.createElement("section");
    section.hidden = true;
    section.innerHTML = "<h2>Data quality</h2><p>Historical diagnostics</p>";
    Object.defineProperty(section, "offsetWidth", { configurable: true, value: 0 });
    Object.defineProperty(section, "offsetHeight", { configurable: true, value: 0 });
    document.body.appendChild(section);

    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });

    try {
      await captureSectionsAsPDF([section], "License report");
    } finally {
      section.remove();
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
      if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }

    expect(mocks.toPng).toHaveBeenCalledOnce();
    const [capturedClone, options] = mocks.toPng.mock.calls[0] as unknown as [
      HTMLElement,
      { width: number; height: number },
    ];
    expect(capturedClone.hidden).toBe(false);
    expect(options.width).toBeGreaterThan(0);
    expect(options.height).toBeGreaterThan(0);
    expect(mocks.triggerDownload).toHaveBeenCalledOnce();
  });
});
