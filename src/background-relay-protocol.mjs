import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const RELAY_FRAME_LIMIT = 1024 * 1024;
export const RELAY_REPLY_LIMIT = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const sign = (secret, domain, ...values) => createHmac("sha256", secret).update(JSON.stringify(["minhspark-background-relay", 1, domain, ...values])).digest("base64url");
const equal = (left, right) => typeof left === "string" && NONCE.test(left) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function relayHello(workerId = null, id = randomUUID()) {
  return { schemaVersion: 1, type: "hello", id, workerId, clientNonce: randomBytes(32).toString("base64url") };
}

export function validRelayHello(value) {
  return keys(value, ["schemaVersion", "type", "id", "workerId", "clientNonce"]) && value.schemaVersion === 1 && value.type === "hello"
    && UUID.test(value.id) && (value.workerId === null || UUID.test(value.workerId)) && NONCE.test(value.clientNonce);
}

export function relayChallenge(secret, hello) {
  const serverNonce = randomBytes(32).toString("base64url");
  return { schemaVersion: 1, type: "challenge", id: hello.id, serverNonce, proof: sign(secret, "server-proof", hello, serverNonce) };
}

export function verifyRelayChallenge(secret, hello, value) {
  return keys(value, ["schemaVersion", "type", "id", "serverNonce", "proof"]) && value.schemaVersion === 1 && value.type === "challenge"
    && value.id === hello.id && NONCE.test(value.serverNonce) && equal(value.proof, sign(secret, "server-proof", hello, value.serverNonce));
}

export function relayOperation(secret, hello, challenge, operation) {
  return { schemaVersion: 1, type: "operation", operation, proof: sign(secret, "client-operation", hello, challenge.serverNonce, operation) };
}

export function verifyRelayOperation(secret, hello, challenge, value) {
  const operation = value?.operation;
  return keys(value, ["schemaVersion", "type", "operation", "proof"]) && value.schemaVersion === 1 && value.type === "operation"
    && keys(operation, ["schemaVersion", "id", "workerId", "clientPid", "method", "params"]) && operation.schemaVersion === 1
    && operation.id === hello.id && operation.workerId === hello.workerId && Number.isSafeInteger(operation.clientPid) && operation.clientPid > 0
    && ["status", "list", "read", "send", "drain"].includes(operation.method) && object(operation.params)
    && equal(value.proof, sign(secret, "client-operation", hello, challenge.serverNonce, operation));
}

export function relayResponse(secret, hello, challenge, response) {
  return { schemaVersion: 1, type: "response", response, proof: sign(secret, "server-response", hello, challenge.serverNonce, response) };
}

export function verifyRelayResponse(secret, hello, challenge, value) {
  const response = value?.response;
  return keys(value, ["schemaVersion", "type", "response", "proof"]) && value.schemaVersion === 1 && value.type === "response"
    && object(response) && response.schemaVersion === 1 && response.id === hello.id
    && (keys(response, ["schemaVersion", "id", "result"]) || keys(response, ["schemaVersion", "id", "error"]) && object(response.error))
    && equal(value.proof, sign(secret, "server-response", hello, challenge.serverNonce, response));
}
