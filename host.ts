import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contracts";
import { collectChanges, readDiff, resolveRepositories } from "./git";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    resolve: ({ rootPath, paths }, context) => resolveRepositories(rootPath, paths, context.signal),
    status: ({ rootPath, repositoryPaths }, context) => collectChanges(rootPath, repositoryPaths, context.signal),
    diff: ({ rootPath, repositoryPath, path, layer }, context) => readDiff(rootPath, repositoryPath, path, layer, context.signal),
  },
});
