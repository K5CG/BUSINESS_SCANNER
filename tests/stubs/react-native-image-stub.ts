type Size = { width: number; height: number };

const sizes = new Map<string, Size>();
let windowSize: Size = { width: 1080, height: 2400 };

export function resetReactNativeImageStub(): void {
  sizes.clear();
  windowSize = { width: 1080, height: 2400 };
}

export function setStubImageSize(uri: string, width: number, height: number): void {
  sizes.set(uri, { width, height });
}

export function setStubWindowSize(width: number, height: number): void {
  windowSize = { width, height };
}

export const Image = {
  getSize(
    uri: string,
    success: (width: number, height: number) => void,
    failure?: (error: Error) => void
  ): void {
    const size = sizes.get(uri);
    if (!size) {
      failure?.(new Error(`missing stub size: ${uri}`));
      return;
    }
    success(size.width, size.height);
  },
};

export const Dimensions = {
  get(): Size {
    return windowSize;
  },
};

export const Platform = {
  OS: 'android',
};
