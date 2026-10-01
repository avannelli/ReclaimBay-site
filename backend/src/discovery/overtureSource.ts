/*
 * Reads Overture Places straight from Overture's public S3 bucket with
 * DuckDB (the access method Overture documents). Only the columns ReclaimBay
 * needs are selected, and the bounding-box filter lets DuckDB skip every
 * Parquet row group outside the area, so a county reads a few megabytes of
 * a release that is several gigabytes. Nothing is written to disk.
 *
 * Loaded lazily by the importer only: the web server never loads DuckDB.
 */
import { DuckDBInstance, JsonDuckDBValueConverter } from "@duckdb/node-api";
import type { BBox } from "./boundaries.js";
import { categoriesFor } from "./categories.js";
import { OVERTURE_PLACES_PATH, isOvertureRelease, type OvertureRow, type OvertureSource } from "./overture.js";

const num = (n: number) => {
  if (!Number.isFinite(n)) throw new Error("bounding box must be finite numbers");
  return n.toFixed(7);
};

/** The SELECT for one release and box. Values are validated before they are inlined. */
export function overturePlacesSql(release: string, bbox: BBox): string {
  if (!isOvertureRelease(release)) throw new Error(`Not an Overture release: ${release}`);
  const [x0, y0, x1, y1] = bbox;
  // Snake-case category codes from categories.ts: safe to inline.
  const tiered = categoriesFor("overture", ["core", "adjacent"]).map((c) => `'${c}'`).join(", ");
  return `
SELECT
  id,
  names.primary AS name,
  taxonomy,
  confidence,
  operating_status,
  websites,
  phones,
  brand.names.primary AS brand,
  addresses,
  list_transform(coalesce(sources, []), s -> {'dataset': s.dataset, 'license': s.license}) AS sources,
  bbox.xmin AS lon,
  bbox.ymin AS lat
FROM read_parquet('${OVERTURE_PLACES_PATH(release)}*', hive_partitioning = 1)
WHERE bbox.xmin >= ${num(x0)} AND bbox.xmax <= ${num(x1)}
  AND bbox.ymin >= ${num(y0)} AND bbox.ymax <= ${num(y1)}
  AND (
    list_contains(taxonomy.hierarchy, 'automotive_service')
    OR len(list_intersect(coalesce(taxonomy.alternates, []), [${tiered}])) > 0
  )`;
}

export function duckdbOvertureSource(): OvertureSource {
  return {
    async *query(release: string, bbox: BBox) {
      const instance = await DuckDBInstance.create(":memory:");
      const connection = await instance.connect();
      try {
        // Overture's bucket is public: anonymous reads in its region.
        await connection.run("SET s3_region = 'us-west-2'");
        const result = await connection.stream(overturePlacesSql(release, bbox));
        const names = result.columnNames();
        for (;;) {
          const chunk = await result.fetchChunk();
          if (!chunk || chunk.rowCount === 0) break;
          const rows = chunk
            .convertRows(JsonDuckDBValueConverter)
            .map((values) => Object.fromEntries(names.map((n, i) => [n, values[i] ?? null])) as unknown as OvertureRow);
          yield rows;
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    },
  };
}
