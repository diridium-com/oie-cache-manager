/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

import java.util.List;

import javax.ws.rs.Consumes;
import javax.ws.rs.DELETE;
import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.PUT;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.MediaType;

import com.mirth.connect.client.core.ClientException;
import com.mirth.connect.client.core.Operation.ExecuteType;

import com.mirth.connect.client.core.api.BaseServletInterface;
import com.mirth.connect.client.core.api.MirthOperation;
import com.mirth.connect.client.core.api.Param;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.tags.Tag;

@Path("/extensions/oie-cache-manager")
@Tag(name = "OIE Cache Manager")
@Consumes({MediaType.APPLICATION_JSON, MediaType.APPLICATION_XML})
@Produces({MediaType.APPLICATION_JSON, MediaType.APPLICATION_XML})
public interface CacheServletInterface extends BaseServletInterface {

    String PLUGIN_NAME = "OIE Cache Manager";

    // ========== Cache Definition CRUD ==========

    @GET
    @Path("/definitions")
    @Operation(summary = "List all cache definitions")
    @MirthOperation(name = "getCacheDefinitions", display = "List cache definitions",
            permission = CachePermissions.VIEW, type = ExecuteType.ASYNC, auditable = false)
    List<CacheDefinition> getCacheDefinitions() throws ClientException;

    @GET
    @Path("/definitions/{id}")
    @Operation(summary = "Get a cache definition by ID")
    @MirthOperation(name = "getCacheDefinition", display = "Get cache definition",
            permission = CachePermissions.VIEW, type = ExecuteType.ASYNC, auditable = false)
    CacheDefinition getCacheDefinition(
            @Param("id") @Parameter(description = "Cache definition ID", required = true)
            @PathParam("id") String id) throws ClientException;

    @POST
    @Path("/definitions")
    @Operation(summary = "Create a new cache definition")
    @MirthOperation(name = "createCacheDefinition", display = "Create cache definition",
            permission = CachePermissions.MANAGE, type = ExecuteType.SYNC)
    CacheDefinition createCacheDefinition(
            @Param("definition") @Parameter(description = "The cache definition to create", required = true)
            CacheDefinition definition) throws ClientException;

    @PUT
    @Path("/definitions/{id}")
    @Operation(summary = "Update an existing cache definition")
    @MirthOperation(name = "updateCacheDefinition", display = "Update cache definition",
            permission = CachePermissions.MANAGE, type = ExecuteType.SYNC)
    CacheDefinition updateCacheDefinition(
            @Param("id") @Parameter(description = "Cache definition ID", required = true)
            @PathParam("id") String id,
            @Param("definition") @Parameter(description = "The updated cache definition", required = true)
            CacheDefinition definition) throws ClientException;

    @DELETE
    @Path("/definitions/{id}")
    @Operation(summary = "Delete a cache definition")
    @MirthOperation(name = "deleteCacheDefinition", display = "Delete cache definition",
            permission = CachePermissions.MANAGE, type = ExecuteType.SYNC)
    void deleteCacheDefinition(
            @Param("id") @Parameter(description = "Cache definition ID", required = true)
            @PathParam("id") String id) throws ClientException;

    // ========== Cache Operations ==========

    @POST
    @Path("/definitions/{id}/refresh")
    @Operation(summary = "Refresh a cache (re-fetch entries currently in memory)")
    @MirthOperation(name = "refreshCache", display = "Refresh cache",
            permission = CachePermissions.MANAGE, type = ExecuteType.ASYNC)
    void refreshCache(
            @Param("id") @Parameter(description = "Cache definition ID", required = true)
            @PathParam("id") String id) throws ClientException;

    @POST
    @Path("/definitions/{id}/testConnection")
    @Operation(summary = "Test the JDBC connection for a cache definition")
    @MirthOperation(name = "testConnection", display = "Test connection",
            permission = CachePermissions.MANAGE, type = ExecuteType.ASYNC)
    String testConnection(
            @Param("id") @Parameter(description = "Cache definition ID", required = true)
            @PathParam("id") String id) throws ClientException;

    @POST
    @Path("/testConnectionInline")
    @Operation(summary = "Test a JDBC connection using an unsaved cache definition")
    @MirthOperation(name = "testConnectionInline", display = "Test connection",
            permission = CachePermissions.MANAGE, type = ExecuteType.SYNC)
    String testConnectionInline(
            @Param("definition") @Parameter(description = "Cache definition with connection details", required = true)
            CacheDefinition definition) throws ClientException;

    @POST
    @Path("/testQueryInline")
    @Operation(summary = "Test a query using an unsaved cache definition with a sample key")
    @MirthOperation(name = "testQueryInline", display = "Test query",
            permission = CachePermissions.MANAGE, type = ExecuteType.SYNC)
    String testQueryInline(
            @Param("definition") @Parameter(description = "Cache definition with query details", required = true)
            CacheDefinition definition,
            @Param("sampleKey") @Parameter(description = "Sample key to test the query with", required = true)
            @QueryParam("sampleKey") String sampleKey) throws ClientException;

    @GET
    @Path("/statistics")
    @Operation(summary = "Get runtime statistics for all caches")
    @MirthOperation(name = "getAllCacheStatistics", display = "Get all cache statistics",
            permission = CachePermissions.VIEW, type = ExecuteType.ASYNC, auditable = false)
    List<CacheStatistics> getAllCacheStatistics() throws ClientException;

    @GET
    @Path("/definitions/{id}/statistics")
    @Operation(summary = "Get runtime statistics for a cache")
    @MirthOperation(name = "getCacheStatistics", display = "Get cache statistics",
            permission = CachePermissions.VIEW, type = ExecuteType.ASYNC, auditable = false)
    CacheStatistics getCacheStatistics(
            @Param("id") @Parameter(description = "Cache definition ID", required = true)
            @PathParam("id") String id) throws ClientException;

    @GET
    @Path("/definitions/{id}/snapshot")
    @Operation(summary = "Get a point-in-time snapshot of cache statistics and entries")
    @MirthOperation(name = "getCacheSnapshot", display = "Get cache snapshot",
            permission = CachePermissions.VIEW, type = ExecuteType.ASYNC, auditable = false)
    CacheSnapshot getCacheSnapshot(
            @Param("id") @Parameter(description = "Cache definition ID", required = true)
            @PathParam("id") String id,
            @Param("offset") @Parameter(description = "Number of entries to skip (default 0)")
            @QueryParam("offset") @javax.ws.rs.DefaultValue("0") int offset,
            @Param("limit") @Parameter(description = "Max entries to return (default 1000)")
            @QueryParam("limit") @javax.ws.rs.DefaultValue("1000") int limit,
            @Param("sortBy") @Parameter(description = "Sort field: key, value, loadedAt, accessCount")
            @QueryParam("sortBy") @javax.ws.rs.DefaultValue("key") String sortBy,
            @Param("sortDir") @Parameter(description = "Sort direction: asc or desc")
            @QueryParam("sortDir") @javax.ws.rs.DefaultValue("asc") String sortDir,
            @Param("filter") @Parameter(description = "Filter text")
            @QueryParam("filter") String filter,
            @Param("filterScope") @Parameter(description = "Filter scope: key, value, or both")
            @QueryParam("filterScope") @javax.ws.rs.DefaultValue("key") String filterScope,
            @Param("filterRegex") @Parameter(description = "Treat filter as regex")
            @QueryParam("filterRegex") @javax.ws.rs.DefaultValue("false") boolean filterRegex
    ) throws ClientException;
}
