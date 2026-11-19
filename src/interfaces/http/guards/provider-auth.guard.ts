import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Deliberate no-op for this challenge iteration. Replace with an OIDC adapter
 * implementing ProviderIdentityPort; no local user/password store is used.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
    canActivate(_context: ExecutionContext): boolean {
        return true;
    }
}
