export interface ChatSurfaceAdapter {
  isSupported(): Promise<boolean>;
  sendControlText(text: string): Promise<void>;
  observeAssistantControls(onControl: (text: string) => void): () => void;
  conversationIdentity(): Promise<string | null>;
}

export interface ChatGptSurfaceDependencies {
  document: Document;
  location: Location;
}

export class ChatGptSurfaceAdapter implements ChatSurfaceAdapter {
  constructor(private readonly dependencies: ChatGptSurfaceDependencies) {}

  async isSupported(): Promise<boolean> {
    return false;
  }

  async sendControlText(_text: string): Promise<void> {
    throw new Error("RELAY_UI_UNSUPPORTED");
  }

  observeAssistantControls(_onControl: (text: string) => void): () => void {
    return () => undefined;
  }

  async conversationIdentity(): Promise<string | null> {
    const match = this.dependencies.location.pathname.match(/^\/c\/([^/?#]+)(?:\/|$)/);
    return match?.[1] ?? null;
  }
}
