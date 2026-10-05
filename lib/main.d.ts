import type { TextEditor, Point, Range } from "lumine";

type MaybePromise<T> = T | Promise<T>;
type Disposable = { dispose(): void };
export type PointCompatible = Point | [number, number] | { row: number; column: number };
export type RangeCompatible =
  Range | [PointCompatible, PointCompatible] | { start: PointCompatible; end: PointCompatible };

export type FileSymbol = {
  name: string;
  shortName?: string;
  tag?: string;
  icon?: string;
  context?: string;
  path?: string;
  uri?: string;
  cell?: number;
  directory?: string;
  file?: string;
} & (
  | { position: PointCompatible; range?: RangeCompatible }
  | { position?: PointCompatible; range: RangeCompatible }
);

export type NormalizedSymbol = FileSymbol & {
  position: Point;
  range: Range;
  providerName: string;
  providerId: string;
};
export type FileSymbolTree = NormalizedSymbol & { children: FileSymbolTree[] };
export type WorkspaceSymbol = FileSymbol &
  ({ path: string } | { uri: string } | { directory: string; file: string });
export type RequestStatus = {
  state: "ready" | "unavailable" | "starting" | "partial" | "error";
  message?: string;
};
export type SymbolRequest = { signal: AbortSignal; timeoutMs?: number };

type ProviderIdentity = { name: string; packageName: string };
export interface DocumentSymbolProvider extends ProviderIdentity {
  canProvideDocumentSymbols(editor: TextEditor): MaybePromise<boolean | number>;
  getDocumentSymbols(editor: TextEditor, request: SymbolRequest): MaybePromise<FileSymbol[] | null>;
  onDidInvalidateDocumentSymbols?(
    callback: (event: { editor?: TextEditor | null }) => void,
  ): Disposable;
}
export interface WorkspaceSymbolProvider extends ProviderIdentity {
  searchWorkspaceSymbols(
    query: string,
    request: SymbolRequest & {
      paths: string[];
      onSymbols?: (symbols: WorkspaceSymbol[]) => void;
      onStatus?: (status: RequestStatus) => void;
    },
  ): MaybePromise<WorkspaceSymbol[] | null>;
  onDidInvalidateWorkspaceSymbols?(callback: () => void): Disposable;
}
export interface DefinitionProvider extends ProviderIdentity {
  canProvideDefinitions(editor: TextEditor): MaybePromise<boolean | number>;
  getDefinitions(
    editor: TextEditor,
    request: SymbolRequest & { range?: Range },
  ): MaybePromise<FileSymbol[] | null>;
}
export type ProviderDescriptor = ProviderIdentity & {
  role: "document" | "workspace" | "definition";
};
export interface SymbolRegistry {
  getFileSymbols(editor: TextEditor): Promise<NormalizedSymbol[] | null>;
  peekFileSymbols(editor: TextEditor): NormalizedSymbol[] | null;
  getFileSymbolTree(editor: TextEditor): Promise<FileSymbolTree[] | null>;
  peekFileSymbolTree(editor: TextEditor): FileSymbolTree[] | null;
  onDidInvalidateFileSymbols(
    callback: (event: { editor: TextEditor | null; provider: ProviderDescriptor | null }) => void,
  ): Disposable;
  searchWorkspace(
    query?: string,
    options?: {
      signal?: AbortSignal;
      onSymbols?: (symbols: NormalizedSymbol[]) => void;
      onStatus?: (status: RequestStatus) => void;
    },
  ): Promise<NormalizedSymbol[] | null>;
  onDidInvalidateWorkspaceSymbols(callback: () => void): Disposable;
  findDefinitions(
    editor: TextEditor,
    options?: {
      range?: Range;
      signal?: AbortSignal;
      onStatus?: (status: RequestStatus) => void;
    },
  ): Promise<NormalizedSymbol[] | null>;
  providers(): ProviderDescriptor[];
  onDidChangeProviders(callback: () => void): Disposable;
}
