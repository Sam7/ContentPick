import '@testing-library/jest-dom/vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.classList.contains('tree')) {
    return { x: 0, y: 0, width: 720, height: 224, top: 0, right: 720, bottom: 224, left: 0, toJSON: () => ({}) };
  }
  return originalGetBoundingClientRect.call(this);
};
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    if (this.classList.contains('tree')) return 224;
    return originalClientHeight?.get?.call(this) ?? 0;
  },
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() {
    if (this.classList.contains('tree')) return 224;
    return originalOffsetHeight?.get?.call(this) ?? 0;
  },
});
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    if (this.classList.contains('tree')) return 720;
    return originalOffsetWidth?.get?.call(this) ?? 0;
  },
});
