import { Amplify } from "aws-amplify";

// These values come from CDK outputs after deploy.
// Copy them from the terminal or CloudFormation outputs.
// For local dev, create a .env.local file with these values.

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID!,
      userPoolClientId: process.env.NEXT_PUBLIC_CLIENT_ID!,
      loginWith: {
        oauth: {
          domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN!,
          scopes: ["email", "openid", "profile"],
          redirectSignIn: [
            "http://localhost:3000/auth/callback",
            process.env.NEXT_PUBLIC_REDIRECT_SIGN_IN || "",
          ].filter(Boolean),
          redirectSignOut: [
            "http://localhost:3000",
            process.env.NEXT_PUBLIC_REDIRECT_SIGN_OUT || "",
          ].filter(Boolean),
          responseType: "code",
        },
      },
    },
  },
});
