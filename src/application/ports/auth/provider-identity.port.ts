export interface ProviderIdentity {
    providerId: string;
    subject: string;
}

/** Extension point for an external OIDC/JWT identity provider (e.g. Keycloak). */
export interface ProviderIdentityPort {
    verifyAuthorizationHeader(authorization: string | undefined): Promise<ProviderIdentity>;
}
