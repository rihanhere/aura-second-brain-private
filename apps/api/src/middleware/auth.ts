import type { NextFunction, Request, Response } from "express";

export interface AuthedRequest extends Request {
  userId: string;
}

export function getUserId(req: Request) {
  return (req as unknown as AuthedRequest).userId || "guest-beta-user";
}

export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const headerUserId = req.header("x-user-id");
  (req as unknown as AuthedRequest).userId = headerUserId || "guest-beta-user";
  next();
}
