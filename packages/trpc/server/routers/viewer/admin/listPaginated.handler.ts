import { getUserRepository } from "@calcom/features/di/containers/UserRepository";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { TrpcSessionUser } from "../../../types";
import type { TListMembersSchema } from "./listPaginated.schema";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TListMembersSchema;
};
const listPaginatedHandler = async ({ input }: GetOptions) => {
  const userRepository = getUserRepository();

  const { cursor, limit, searchTerm } = input;
  const organizationId = isOrganizationsEnabled() ? (input.organizationId ?? null) : null;

  const { users, total, nextCursor } = await userRepository.listUsers({
    searchTerm,
    limit,
    cursor,
    organizationId,
  });

  return {
    rows: users,
    nextCursor,
    meta: {
      totalRowCount: total,
    },
  };
};

export default listPaginatedHandler;
