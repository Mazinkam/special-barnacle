// Import the canonical JSON, not bridge/extensions/orchestrator/contract.json's symlink.
// Bun's test-file isolation can resolve that symlink as an empty module while loading
// multiple files; this path also lets Bun.build embed the contract in Node drivers.
import contract from "../../../orchestrator/contract.json";

export default contract;
