/** GENERATED from collab/packages/protocol. Do not edit by hand. */
// @ts-nocheck

/** Shared mutation and durable-ACK identity for collab, website, and editor. */

export function allocateClientTransactionId(prefix = "txn") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now().toString(16)}`;
}

export function createMutationIdentity({
  clientId,
  clientTransactionId,
  clientSequence,
} = {}) {
  const resolvedClientId = String(clientId || "").trim();
  const resolvedTransactionId = String(clientTransactionId || "").trim();
  const resolvedSequence = Number.isInteger(clientSequence)
    ? clientSequence
    : null;
  if (
    !resolvedClientId ||
    !resolvedTransactionId ||
    resolvedSequence === null ||
    resolvedSequence < 0
  ) {
    return null;
  }
  return {
    clientId: resolvedClientId,
    clientTransactionId: resolvedTransactionId,
    clientSequence: resolvedSequence,
  };
}

export function isExactDurableAck(payload, expected = {}) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if (payload.durable !== true) {
    return false;
  }
  if (payload.ok === false) {
    return false;
  }
  if (payload.type && payload.type !== "ack") {
    return false;
  }
  const expectedTransactionId = String(
    expected.clientTransactionId || "",
  ).trim();
  const actualTransactionId = String(payload.clientTransactionId || "").trim();
  if (!actualTransactionId) {
    return false;
  }
  if (expectedTransactionId && actualTransactionId !== expectedTransactionId) {
    return false;
  }
  const expectedSeq = Number.isInteger(expected.clientSequence)
    ? expected.clientSequence
    : Number.isInteger(expected.seq)
      ? expected.seq
      : null;
  if (expectedSeq !== null && Number(payload.seq) !== expectedSeq) {
    return false;
  }
  if (
    Number.isInteger(expected.lastLogId) &&
    Number(payload.lastLogId) !== Number(expected.lastLogId)
  ) {
    return false;
  }
  return true;
}
