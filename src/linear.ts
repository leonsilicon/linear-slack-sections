import { Http } from "./http";
import {
  array,
  type EntityConfig,
  fail,
  type LinearPort,
  object,
  type Snapshot,
  string,
  uuid,
} from "./model";

export class Linear implements LinearPort {
  constructor(
    private readonly apiKey: string,
    private readonly http = new Http(),
  ) {}

  async snapshot(entities: EntityConfig[]): Promise<Snapshot> {
    const declarations = entities.map((_, index) => `$id${index}: String!`).join(", ");
    const fields = entities
      .map((entity, index) => {
        const status =
          entity.kind === "issue" ? "state { name }" : "status { name } slackChannelId";
        return `e${index}: ${entity.kind}(id: $id${index}) { id archivedAt ${status} }`;
      })
      .join("\n");
    const variables = Object.fromEntries(
      entities.map((entity, index) => [`id${index}`, entity.ref]),
    );
    const response = await this.http.json(
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query StatusSnapshot(${declarations}) { organization { id } ${fields} }`,
          variables,
        }),
      },
      "read",
    );
    if (response.errors !== undefined && array(response.errors).length) {
      fail("LINEAR", "Linear returned GraphQL errors; no partial snapshot will be applied.");
    }
    const data = object(response.data);
    const workspaceId = string(object(data.organization).id).toLowerCase();
    if (!uuid.test(workspaceId)) fail("SCHEMA", "Linear workspace identity is invalid.");
    return {
      workspaceId,
      entities: entities.map((config, index) => {
        const entity = object(data[`e${index}`]);
        const id = string(entity.id).toLowerCase();
        if (!uuid.test(id)) fail("SCHEMA", "Linear entity identity is invalid.");
        if (entity.archivedAt !== null)
          fail(
            "ARCHIVED_ENTITY",
            "Archived or unreadable Linear entity; remove it from config to stop managing it.",
          );
        const status = string(object(entity[config.kind === "issue" ? "state" : "status"]).name);
        const base = { kind: config.kind, id, status };
        return config.kind === "project" && entity.slackChannelId != null
          ? { ...base, projectChannelId: string(entity.slackChannelId) }
          : base;
      }),
    };
  }
}
