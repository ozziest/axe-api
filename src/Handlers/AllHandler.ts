import { IRequestPack, IHookParameter } from "../Interfaces";
import {
  addForeignKeyQuery,
  getRelatedData,
  serializeData,
  filterHiddenFields,
  callHooks,
} from "./Helpers";
import { IoCService, QueryService, ModelListService } from "../Services";
import { HandlerTypes, HookFunctionTypes } from "../Enums";
import { Knex } from "knex";

export default async (pack: IRequestPack) => {
  const modelList = await IoCService.useByType<ModelListService>(
    "ModelListService"
  );
  const { model, req, res, database, relation, parentModel } = pack;
  const queryParser = new QueryService(model, modelList.get());

  // We should parse URL query string to use as condition in Lucid query
  const conditions = queryParser.get(req.query);

  // Creating a new database query
  const query = (database as Knex).from(model.instance.table);

  // Users should be able to select some fields to show.
  queryParser.applyFields(query, conditions.fields);

  // Binding parent id if there is.
  addForeignKeyQuery(req, query, relation, parentModel);

  // Users should be able to filter records
  queryParser.applyWheres(query, conditions.q);

  await callHooks(model, HookFunctionTypes.onBeforeAll, {
    ...pack,
    conditions,
    query,
  } as unknown as IHookParameter);

  // User should be able to select sorting fields and types
  queryParser.applySorting(query, conditions.sort);

  let result = await query;

  // We should try to get related data if there is any
  await getRelatedData(
    result,
    conditions.with,
    model,
    modelList,
    database,
    HandlerTypes.ALL,
    req
  );

  await callHooks(model, HookFunctionTypes.onAfterAll, {
    ...pack,
    result,
    conditions,
    query,
  } as unknown as IHookParameter);

  // Serializing the data by the model's serialize method
  result = await serializeData(
    result,
    model.instance.serialize,
    HandlerTypes.ALL,
    req
  );

  // Filtering hidden fields from the response data.
  filterHiddenFields(result, model.instance.hiddens);

  return res.json(result);
};
