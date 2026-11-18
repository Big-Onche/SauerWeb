import WebSocket from "ws";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9223";
const seconds = Number(process.argv[3] ?? 20);
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes("/game?"));
if (!target) throw new Error(`No SauerWeb game page is available at ${endpoint}.`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
let sequence = 0;
const pending = new Map();
socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (!message.id) return;
  const operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id);
  if (message.error) operation.reject(new Error(message.error.message));
  else operation.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await Promise.all([send("Runtime.enable"), send("Profiler.enable"), send("HeapProfiler.enable")]);
for (let attempt = 0; attempt < 120; attempt++) {
  const result = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  if (result.result.value?.startsWith("triforts")) break;
  await delay(500);
}
await send("HeapProfiler.collectGarbage");
await pressKey("KeyO", "O", 8);
await pressKey("KeyO", "O", 9);
await send("Profiler.setSamplingInterval", { interval: 1000 });
await send("HeapProfiler.startSampling", {
  samplingInterval: 16384,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
await send("Profiler.start");
const heapSamples = [];
for (let second = 0; second < seconds; second++) {
  await delay(1000);
  const usage = await send("Runtime.getHeapUsage");
  heapSamples.push(Math.round(usage.usedSize / (1024 * 1024)));
}
const [{ profile: cpuProfile }, { profile: heapProfile }] = await Promise.all([send("Profiler.stop"), send("HeapProfiler.stopSampling")]);
const overlay = await send("Runtime.evaluate", {
  expression: "document.querySelector('.render-stats-overlay')?.textContent ?? ''",
  returnByValue: true,
});

const cpuNodes = new Map(cpuProfile.nodes.map((node) => [node.id, node]));
const cpuCounts = new Map();
for (const sample of cpuProfile.samples ?? []) cpuCounts.set(sample, (cpuCounts.get(sample) ?? 0) + 1);
const cpu = [...cpuCounts].map(([id, count]) => ({ ...frame(cpuNodes.get(id).callFrame), milliseconds: count }))
  .sort((first, second) => second.milliseconds - first.milliseconds).slice(0, 30);
const allocations = [];
visitHeap(heapProfile.head, allocations);
allocations.sort((first, second) => second.bytes - first.bytes);

console.log(JSON.stringify({ seconds, heapMiB: heapSamples, overlay: overlay.result.value, cpu, allocations: allocations.slice(0, 40) }, null, 2));
socket.close();

function visitHeap(node, output) {
  if (node.selfSize) output.push({ ...frame(node.callFrame), bytes: node.selfSize, mebibytes: Number((node.selfSize / (1024 * 1024)).toFixed(2)) });
  for (const child of node.children ?? []) visitHeap(child, output);
}

function frame(callFrame) {
  return { function: callFrame?.functionName || "(anonymous)", url: callFrame?.url || "", line: (callFrame?.lineNumber ?? -1) + 1,
    column: (callFrame?.columnNumber ?? -1) + 1 };
}

async function pressKey(code, key, modifiers) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", code, key, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, modifiers });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
