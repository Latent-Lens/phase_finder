export function deep_clone(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (Array.isArray(value)) return value.map(deep_clone);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep_clone(item)]));
  }
  return value;
}
