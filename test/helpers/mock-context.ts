import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

const mockModel = { id: "mock", name: "mock", api: { id: "mock" } } as unknown as Model<Api>;

export function createMockContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  return {
    cwd: "/tmp/pi-imps-test",
    model: mockModel,
    modelRegistry: {
      getAvailable: () => [mockModel],
    } as unknown as ModelRegistry,
    ...overrides,
  } as ExtensionContext;
}
