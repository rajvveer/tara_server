declare global {
  namespace Express {
    interface Request {
      id: string;
      userId?: string;
    }
  }
}

export {};
