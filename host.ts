import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contracts";
import { collectChanges, readDiff, resolveRepositories } from "./git";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    resolve: ({ rootPath, paths }, context) => resolveRepositories(rootPath, paths, context.signal),
    status: ({ rootPath, repositoryPaths, mergeBaseBranch }, context) => collectChanges(rootPath, repositoryPaths, context.signal, mergeBaseBranch),
    diff: ({ rootPath, repositoryPath, path, layer, baseBranch }, context) => readDiff(rootPath, repositoryPath, path, layer, context.signal, baseBranch),
  },
});
