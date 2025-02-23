import { Knex } from "knex";
import { IRequestPack, IHookParameter } from "../Interfaces";
import {
  addForeignKeyQuery,
  getRelatedData,
  serializeData,
  filterHiddenFields,
  callHooks,
} from "./Helpers";
import { HandlerTypes, HookFunctionTypes } from "../Enums";
import { IoCService, QueryService, ModelListService } from "../Services";

export default async (pack: IRequestPack) => {
  const modelList = await IoCService.useByType<ModelListService>(
    "ModelListService"
  );
  const { model, req, database, relation, parentModel } = pack;
  const queryParser = new QueryService(model, modelList.get());

  // We should parse URL query string to use as condition in Lucid query
  const conditions = queryParser.get(req.query);

  // Creating a new database query
  const query = (database as Knex).from(model.instance.table);

  // Users should be able to select some fields to show.
  queryParser.applyFields(query, conditions.fields);

  // Binding parent id if there is.
  addForeignKeyQuery(req, query, relation, parentModel);

  await callHooks(model, HookFunctionTypes.onBeforePaginate, {
    ...pack,
    conditions,
    query,
  } as unknown as IHookParameter);

  // Users should be able to filter records
  queryParser.applyWheres(query, conditions.q);

  // User should be able to select sorting fields and types
  queryParser.applySorting(query, conditions.sort);

  const result = await (query as any).paginate({
    perPage: conditions.per_page,
    currentPage: conditions.page,
    isLengthAware: true,
  });

  // We should try to get related data if there is any
  await getRelatedData(
    result.data,
    conditions.with,
    model,
    modelList,
    database,
    HandlerTypes.PAGINATE,
    req
  );

  await callHooks(model, HookFunctionTypes.onAfterPaginate, {
    ...pack,
    conditions,
    result,
    query,
  } as unknown as IHookParameter);

  // Serializing the data by the model's serialize method
  result.data = await serializeData(
    result.data,
    model.instance.serialize,
    HandlerTypes.PAGINATE,
    req
  );

  // Filtering hidden fields from the response data.
  filterHiddenFields(result.data, model.instance.hiddens);

  return pack.res.json(result);
};
