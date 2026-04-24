export function openApiSchemaRef(name: string): Readonly<Record<string, string>> {
  return { $ref: `#/components/schemas/${name}` };
}

export function protocolArtifactRef(artifactName: string): Readonly<Record<string, string>> {
  return { $ref: `../../spec/${artifactName}` };
}
