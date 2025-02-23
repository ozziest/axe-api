import { Relationships, ConditionTypes, SortTypes } from "../Enums";
import {
  IRawQuery,
  IQuery,
  ISortField,
  NestedWhere,
  IWhere,
  IWith,
  IModelService,
} from "../Interfaces";
import { Knex } from "knex";
import ApiError from "../Exceptions/ApiError";
import { WithQueryResolver } from "../Resolvers";

class QueryService {
  model: IModelService;
  models: IModelService[];
  usedConditionColumns: string[];
  relationColumns: string[];
  createdJoins: string[];

  constructor(model: IModelService, models: IModelService[]) {
    this.model = model;
    this.models = models;
    this.createdJoins = [];
    this.relationColumns = [];
    this.usedConditionColumns = [];
  }

  applyFields(query: Knex.QueryBuilder, fields: string[]) {
    // Users should be able to select some fields to show.
    if (fields.length === 0 || (fields.length === 1 && fields[0] === "*")) {
      query.select(`${this.model.instance.table}.*`);
    } else {
      const fullPathFields = fields.map((field) => {
        if (field.includes(".") === false) {
          return `${this.model.instance.table}.${field}`;
        }
        return field;
      });
      query.select([...fullPathFields, ...this.relationColumns]);
    }
  }

  applySorting(query: Knex.QueryBuilder, sort: ISortField[]) {
    if (sort.length === 0) {
      return;
    }

    sort.forEach((item) => {
      query.orderBy(item.name, item.type);
    });
  }

  applyWheresInsideGroup(
    sub: Knex.QueryBuilder,
    ruleSet: NestedWhere | IWhere
  ) {
    // If there is not any query, we don't have to filter the data.
    if (!ruleSet) {
      return;
    }

    if (Array.isArray(ruleSet)) {
      for (const item of ruleSet) {
        // If the item is not an array, it means that it is a standard condition
        if (Array.isArray(item) === false) {
          const condition: IWhere = item as IWhere;
          this.applyConditionRule(sub, condition);
        } else {
          // If the item is an array, we should create the query recursively.
          const firstItem = (item as NestedWhere)[0] as IWhere;
          if (firstItem.prefix === "or") {
            sub.orWhere((sub) => {
              this.applyWheresInsideGroup(sub, item);
            });
          } else {
            sub.where((sub) => {
              this.applyWheresInsideGroup(sub, item);
            });
          }
        }
      }
    } else {
      const condition: IWhere = ruleSet as IWhere;
      this.applyConditionRule(sub, condition);
    }
  }

  applyWheres(query: Knex.QueryBuilder, ruleSet: NestedWhere) {
    query.where((sub) => {
      this.applyWheresInsideGroup(sub, ruleSet);
    });

    this.applyRelatedQueryJoins(query, ruleSet);
  }

  get(query: any): IQuery {
    const conditions: IQuery = this.parseSections(query);
    const usedColumns: string[] = this.getUsedColumns(conditions);
    const undefinedColumns = usedColumns.filter((columnName) => {
      let currentModel: IModelService | undefined = this.model;
      let realColumName = columnName;
      if (columnName.includes(".")) {
        const [table, splittedColumnName] = columnName.split(".");
        currentModel = this.models.find(
          (model) => model.instance.table === table
        );
        realColumName = splittedColumnName;
      }

      return !currentModel || !currentModel.columnNames.includes(realColumName);
    });

    if (undefinedColumns.length > 0) {
      throw new ApiError(
        `Undefined column names: ${undefinedColumns.join(",")}`
      );
    }

    return conditions;
  }

  private getUsedColumns(conditions: IQuery) {
    return [
      ...conditions.fields,
      ...conditions.sort.map((item) => item.name),
      ...Array.from(this.usedConditionColumns),
    ];
  }

  private applyConditionRule(
    sub: Knex.QueryBuilder,
    ruleSet: IWhere
  ): Knex.QueryBuilder {
    const method = this.getConditionMethodName(ruleSet);
    const zeroArguments = ["Null", "NotNull"];
    const oneArguments = ["In", "NotIn", "Between", "NotBetween"];

    const fullFieldPath = `${ruleSet.table}.${ruleSet.field}`;

    if (zeroArguments.indexOf(ruleSet.condition) > -1) {
      const methodName = `${method}${ruleSet.condition}`;
      return (sub as any)[methodName](fullFieldPath) as Knex.QueryBuilder;
    }

    if (oneArguments.indexOf(ruleSet.condition) > -1) {
      const methodName = `${method}${ruleSet.condition}`;
      return (sub as any)[methodName](
        fullFieldPath,
        ruleSet.value
      ) as Knex.QueryBuilder;
    }

    return sub[method](fullFieldPath, ruleSet.condition, ruleSet.value);
  }

  private applyRelatedQueryJoins(
    query: Knex.QueryBuilder,
    ruleSet: NestedWhere
  ) {
    if (!ruleSet) {
      return;
    }

    if (Array.isArray(ruleSet)) {
      for (const item of ruleSet) {
        // If the item is not an array, it means that it is a standard condition
        if (Array.isArray(item) === false) {
          const condition: IWhere = item as IWhere;
          this.applyJoinIfNecessary(query, condition);
        } else {
          this.applyRelatedQueryJoins(query, item as NestedWhere);
        }
      }
    } else {
      this.applyJoinIfNecessary(query, ruleSet);
    }
  }

  private applyJoinIfNecessary(query: Knex.QueryBuilder, ruleSet: IWhere) {
    if (ruleSet.table !== this.model.instance.table) {
      this.addJoinOnce(query, ruleSet);
    }
  }

  private addJoinOnce(query: Knex.QueryBuilder, ruleSet: IWhere) {
    const { model, relation } = ruleSet;
    if (!relation) {
      return;
    }

    if (this.createdJoins.includes(relation.name)) {
      return;
    }

    const tableName = model.instance.table;
    const primaryKey = `${model.instance.table}.${relation.primaryKey}`;
    const foreignKey = `${this.model.instance.table}.${relation.foreignKey}`;
    query.leftJoin(tableName, primaryKey, foreignKey);
    this.createdJoins.push(relation.name);
  }

  private parseSections(sections: IRawQuery): IQuery {
    if (sections.q) {
      const queryContent = sections.q.replace(/%20/g, "").replace(/ /g, "");

      // Users can send an unacceptable query string. We shouldn't allow them to
      // send unacceptable structure because of security reasons.
      try {
        sections.q = JSON.parse(queryContent);
      } catch (err) {
        throw new ApiError(`Unacceptable query string: ${queryContent}`);
      }
    }

    const withQueryResolver = new WithQueryResolver(this.model, this.models);

    const query: IQuery = {
      page: this.parsePage(sections.page),
      per_page: this.parsePerPage(sections.per_page),
      fields: this.parseFields(sections.fields),
      sort: this.parseSortingOptions(sections.sort),
      q: this.parseCondition(sections.q),
      with: withQueryResolver.resolve(sections?.with || ""),
    };

    this.addRelationColumns(query.with);

    return query;
  }

  private parsePage(content: any) {
    const value = parseInt(content);

    if (isNaN(value)) {
      return 1;
    }

    if (value <= 0) {
      return 1;
    }

    return value;
  }

  private parsePerPage(content: any) {
    const value = parseInt(content);

    if (isNaN(value) || value <= 1 || value > 10000) {
      return 10;
    }

    return value;
  }

  private parseFields(content: any): string[] {
    if (!content) {
      return [];
    }

    const strContent = content as string;

    // User should be able to select "all" fields.
    if (strContent.trim() === "*") {
      return ["*"];
    }

    const fields = strContent.split(",");
    fields.forEach((field) => {
      this.shouldBeAcceptableColumn(field);
    });
    return fields;
  }

  private parseSortingOptions(content: any): ISortField[] {
    // If there is not any sorting options, we don't have to return any value
    if (!content) {
      return [];
    }

    const result: ISortField[] = [];
    const strContent = content as string;

    for (let field of strContent.split(",")) {
      let type = SortTypes.ASC;
      if (field.indexOf("-") === 0) {
        type = SortTypes.DESC;
        field = field.substr(1);
      }

      if (field.indexOf("+") === 0) {
        field = field.substr(1);
      }

      this.shouldBeAcceptableColumn(field);
      result.push({
        name: field,
        type,
      });
    }
    return result;
  }

  private parseConditions(conditions: any): NestedWhere {
    if (!Array.isArray(conditions)) {
      throw new Error("An array should be sent to parseConditions() method.");
    }

    return conditions.map((condition) => {
      return this.parseCondition(condition);
    });
  }

  private parseCondition(content: any): NestedWhere {
    if (Array.isArray(content)) {
      return this.parseConditions(content);
    }

    if (!content) {
      return [];
    }

    const wheres: IWhere[] = [];
    for (const key in content) {
      wheres.push(this.parseConditionObject(content, key));
    }

    return wheres;
  }

  private parseConditionObject(content: any, key: string): IWhere {
    const where: IWhere = {
      prefix: null,
      model: this.model,
      table: this.model.instance.table,
      field: key,
      condition: ConditionTypes["="],
      value: content[key],
      relation: null,
    };

    // Sometimes we can have basic OR operations for queries
    if (where.field.indexOf("$or.") === 0) {
      where.prefix = "or";
      where.field = where.field.replace("$or.", "");
    }

    if (where.field.indexOf("$and.") === 0) {
      where.prefix = "and";
      where.field = where.field.replace("$and.", "");
    }

    // If there is not any value, it means that we should check nullable values
    if (where.value === null) {
      // If the client wants to see not nullable values
      if (this.hasSpecialStructure(where.field, ".$not")) {
        where.field = where.field.replace(".$not", "");
        where.condition = ConditionTypes.NotNull;
      } else {
        // So, it means that the clients wants to see null valus
        where.condition = ConditionTypes.Null;
      }
    } else {
      // If there is value, we should check it
      this.applySpecialCondition(where, "$not", ConditionTypes["<>"]);
      this.applySpecialCondition(where, "$gt", ConditionTypes[">"]);
      this.applySpecialCondition(where, "$gte", ConditionTypes[">="]);
      this.applySpecialCondition(where, "$lt", ConditionTypes["<"]);
      this.applySpecialCondition(where, "$lte", ConditionTypes["<="]);
      this.applySpecialCondition(where, "$like", ConditionTypes.LIKE);
      this.applySpecialCondition(where, "$notLike", ConditionTypes["NOT LIKE"]);
      this.applySpecialCondition(where, "$in", ConditionTypes.In);
      this.applySpecialCondition(where, "$notIn", ConditionTypes.NotIn);
      this.applySpecialCondition(where, "$between", ConditionTypes.Between);
      this.applySpecialCondition(
        where,
        "$notBetween",
        ConditionTypes.NotBetween
      );
    }

    if (
      where.condition === ConditionTypes.In ||
      where.condition === ConditionTypes.NotIn
    ) {
      where.value = where.value.split(",");
    }

    if (
      where.condition === ConditionTypes.Between ||
      where.condition === ConditionTypes.NotBetween
    ) {
      where.value = where.value.split(":");
    }

    if (
      where.condition === ConditionTypes.LIKE ||
      where.condition === ConditionTypes["NOT LIKE"]
    ) {
      where.value = where.value.replace(/\*/g, "%");
    }

    // This means that the condition is related with another table
    if (where.field.includes(".")) {
      const [relationName, field] = where.field.split(".");

      const relation = this.model.relations.find(
        (item) =>
          item.name === relationName && item.type === Relationships.HAS_ONE
      );

      if (!relation) {
        throw new ApiError(
          `Unacceptable query field: ${relationName}.${field}`
        );
      }

      const relatedModel = this.models.find(
        (item) => item.name === relation.model
      );

      if (!relatedModel) {
        throw new ApiError(`Undefined model name: ${relation.model}`);
      }

      where.model = relatedModel;
      where.table = relatedModel.instance.table;
      where.relation = relation;
      where.field = field;
    }

    this.shouldBeAcceptableColumn(where.field);
    this.usedConditionColumns.push(`${where.table}.${where.field}`);

    return where;
  }

  private applySpecialCondition(
    where: IWhere,
    structure: string,
    condition: ConditionTypes
  ) {
    structure = `.${structure}`;
    if (this.hasSpecialStructure(where.field, structure)) {
      where.field = where.field.replace(structure, "");
      where.condition = condition;
    }
  }

  private addRelationColumns(withs: IWith[]) {
    withs.forEach((item) => {
      const relation = this.model.relations.find(
        (i) => i.name === item.relationship
      );
      if (!relation) {
        throw new ApiError(`Undefined relation: ${item.relationship}`);
      }

      this.relationColumns.push(
        `${this.model.instance.table}.${relation.foreignKey}`
      );
    });
  }

  private getConditionMethodName(ruleSet: IWhere) {
    if (ruleSet.prefix === "or") {
      return "orWhere";
    }
    return "where";
  }

  private hasSpecialStructure(field: string, structure: string) {
    if (field.indexOf(structure) === -1) {
      return false;
    }

    if (field.indexOf(structure) === field.length - structure.length) {
      return true;
    }

    return false;
  }

  private shouldBeAcceptableColumn(field: string) {
    const regex = /^[0-9,a-z,A-Z_.]+$/;
    if (!field.match(regex)) {
      throw new ApiError(`Unacceptable field name: ${field}`);
    }

    if (field.indexOf(".") === 0 || field.indexOf(".") === field.length - 1) {
      throw new ApiError(
        `You have to define the column specefically: ${field}`
      );
    }
  }
}

export default QueryService;
