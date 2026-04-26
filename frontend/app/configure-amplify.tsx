"use client";

import { Amplify } from "aws-amplify";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID!,
      userPoolClientId: process.env.NEXT_PUBLIC_CLIENT_ID!,
      loginWith: {
        oauth: {
          domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN!,
          scopes: ["email", "openid", "profile"],
          redirectSignIn: ["http://localhost:3000/auth/callback"],
          redirectSignOut: ["http://localhost:3000"],
          responseType: "code" as const,
        },
      },
    },
  },
});

export function ConfigureAmplify() {
  return null;
}