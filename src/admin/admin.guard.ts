import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { AdminAuthService } from "./admin-auth.service";

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly authService: AdminAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const authHeader = request.headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing authorization token");
    }

    const token = authHeader.slice(7);
    const payload = this.authService.verifyToken(token);
    request.user = payload;
    return true;
  }
}
