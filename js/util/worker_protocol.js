export const WORKER_PROTOCOL_VERSION = 1;

export function worker_message(type, request_id, payload = {}) {
  return { protocolVersion: WORKER_PROTOCOL_VERSION, type, request_id, ...payload };
}

export function is_worker_message(message, types) {
  return Boolean(message)
    && message.protocolVersion === WORKER_PROTOCOL_VERSION
    && Number.isInteger(message.request_id)
    && types.includes(message.type);
}
