import {
  createAnthropicAdapter,
  createCrewAiAdapter,
  createFrameworkBridge,
  createLangChainAdapter,
  createOpenAiAdapter,
  createVercelAiAdapter,
  type AnthropicAdapterResponse,
  type CrewAiAdapterResponse,
  type FrameworkBoundaryContext,
  type FrameworkBoundaryReply,
  type FrameworkBoundaryResolver,
  type FrameworkBridge,
  type FrameworkBridgeOptions,
  type FrameworkBridgeRunOptions,
  type FrameworkCompletedResult,
  type FrameworkDeniedResult,
  type FrameworkFailedResult,
  type FrameworkPausedResult,
  type FrameworkRunResult,
  type LangChainAdapterResponse,
  type OpenAIAdapterResponse,
  type ProviderFrameworkAdapter,
  type VercelAiAdapterResponse,
} from "./framework-adapters.js";

export type SurfaceRunOptions = FrameworkBridgeRunOptions;
export type SurfaceBoundaryContext = FrameworkBoundaryContext;
export type SurfaceBoundaryReply = FrameworkBoundaryReply;
export type SurfaceBoundaryResolver = FrameworkBoundaryResolver;
export type SurfaceBridgeOptions = FrameworkBridgeOptions;
export type SurfacePausedResult = FrameworkPausedResult;
export type SurfaceCompletedResult = FrameworkCompletedResult;
export type SurfaceFailedResult = FrameworkFailedResult;
export type SurfaceDeniedResult = FrameworkDeniedResult;
export type SurfaceRunResult = FrameworkRunResult;
export type SurfaceBridge = FrameworkBridge;
export type ProviderSurfaceAdapter<TResponse> = ProviderFrameworkAdapter<TResponse>;

export type OpenAISurfaceResponse = OpenAIAdapterResponse;
export type AnthropicSurfaceResponse = AnthropicAdapterResponse;
export type VercelAiSurfaceResponse = VercelAiAdapterResponse;
export type LangChainSurfaceResponse = LangChainAdapterResponse;
export type CrewAiSurfaceResponse = CrewAiAdapterResponse;

export const createSurfaceBridge = createFrameworkBridge;
export const createOpenAiSurfaceAdapter = createOpenAiAdapter;
export const createAnthropicSurfaceAdapter = createAnthropicAdapter;
export const createVercelAiSurfaceAdapter = createVercelAiAdapter;
export const createLangChainSurfaceAdapter = createLangChainAdapter;
export const createCrewAiSurfaceAdapter = createCrewAiAdapter;
