/**
 * Plain DTO produced in the MAIN world. Mirrors protocol `SourceInfo`; the ISOLATED world
 * validates it with the zod schema, so nothing here is trusted on the other side.
 */
export type Framework = "vue" | "react" | "svelte" | "angular" | "solid" | "preact";

export interface Frame {
  file: string;
  line: number | null;
  column: number | null;
  componentName: string | null;
}

export interface ResolvedSource {
  framework: Framework | null;
  componentName: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  via: "attribute" | "runtime" | null;
  attribute: string | null;
  stack: Frame[];
  reason: "production-build" | "no-framework" | "no-line" | null;
}

export interface AttributeLocation {
  attribute: string;
  file: string;
  line: number;
  column: number | null;
}
