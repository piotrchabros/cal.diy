import { SIGNUP_ERROR_CODES } from "@calcom/features/auth/signup/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { NextResponse } from "next/server";

export async function respondConflictAs409(
  writeMembership: () => Promise<void>,
  onFailure?: () => Promise<void>
): Promise<NextResponse | null> {
  try {
    await writeMembership();
    return null;
  } catch (error) {
    await onFailure?.();
    if (error instanceof ErrorWithCode && error.code === ErrorCode.Conflict) {
      return NextResponse.json({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS }, { status: 409 });
    }
    throw error;
  }
}
